<?php
function json_success($data, $status = 200) {
    http_response_code($status);
    header('Content-Type: application/json');
    echo json_encode(array('success' => true, 'data' => $data));
    exit;
}

function json_error($message, $status, $extra = array()) {
    http_response_code($status);
    header('Content-Type: application/json');
    $body = array('success' => false, 'error' => $message);
    if (!empty($extra)) {
        $body['details'] = $extra;
    }
    echo json_encode($body);
    exit;
}

function reset_fail($step, $state) {
    json_error('Reset failed', 500, array('step' => $step, 'state' => $state));
}

function reset_db() {
    global $db;

    $seed_customers = array(
        1 => 'Tanaka Taro',
        2 => 'Suzuki Hanako',
        3 => 'Sato Kenji',
    );
    $seed_products = array(
        1 => array('Notebook A4', 150, 500),
        2 => array('Ballpoint Pen (Black)', 80, 1000),
        3 => array('Sticky Notes (Pack)', 200, 300),
        4 => array('USB Flash Drive 32GB', 1200, 100),
        5 => array('Desk Organizer', 800, 50),
    );

    $db->query('SET SESSION innodb_lock_wait_timeout = 5');
    $db->query('SET SESSION lock_wait_timeout = 5');

    if (!$db->begin_transaction()) {
        reset_fail('begin transaction', 'unchanged');
    }

    if (!$db->query('DELETE FROM order_lines')) {
        $db->rollback();
        reset_fail('delete order_lines', 'rolled_back');
    }
    $deleted_lines = (int)$db->affected_rows;

    if (!$db->query('DELETE FROM orders')) {
        $db->rollback();
        reset_fail('delete orders', 'rolled_back');
    }
    $deleted_orders = (int)$db->affected_rows;

    $product_ids = implode(',', array_keys($seed_products));
    if (!$db->query('DELETE FROM products WHERE id NOT IN (' . $product_ids . ')')) {
        $db->rollback();
        reset_fail('delete extra products', 'rolled_back');
    }

    $customer_ids = implode(',', array_keys($seed_customers));
    if (!$db->query('DELETE FROM customers WHERE id NOT IN (' . $customer_ids . ')')) {
        $db->rollback();
        reset_fail('delete extra customers', 'rolled_back');
    }

    $stmt = $db->prepare('INSERT INTO customers (id, name) VALUES (?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)');
    if (!$stmt) {
        $db->rollback();
        reset_fail('prepare customers', 'rolled_back');
    }
    foreach ($seed_customers as $cid => $cname) {
        $stmt->bind_param('is', $cid, $cname);
        if (!$stmt->execute()) {
            $db->rollback();
            reset_fail('restore customers', 'rolled_back');
        }
    }

    $stmt = $db->prepare('INSERT INTO products (id, name, unit_price, stock_quantity) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name), unit_price = VALUES(unit_price), stock_quantity = VALUES(stock_quantity)');
    if (!$stmt) {
        $db->rollback();
        reset_fail('prepare products', 'rolled_back');
    }
    foreach ($seed_products as $pid => $p) {
        $stmt->bind_param('isii', $pid, $p[0], $p[1], $p[2]);
        if (!$stmt->execute()) {
            $db->rollback();
            reset_fail('restore products', 'rolled_back');
        }
    }

    if (!$db->commit()) {
        reset_fail('commit', 'unknown');
    }

    foreach (array('order_lines', 'orders') as $table) {
        if (!$db->query('ALTER TABLE ' . $table . ' AUTO_INCREMENT = 1')) {
            reset_fail('reset auto_increment ' . $table, 'data_reset_auto_increment_pending');
        }
    }

    $r = $db->query('SELECT (SELECT COUNT(*) FROM orders) AS o, (SELECT COUNT(*) FROM order_lines) AS l, (SELECT COUNT(*) FROM products) AS p, (SELECT COUNT(*) FROM customers) AS c');
    $row = $r ? $r->fetch_assoc() : null;
    if (!$row || (int)$row['o'] !== 0 || (int)$row['l'] !== 0 || (int)$row['p'] !== count($seed_products) || (int)$row['c'] !== count($seed_customers)) {
        reset_fail('verify counts', 'unknown');
    }

    $r = $db->query("SELECT table_name AS t, auto_increment AS a FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('orders', 'order_lines')");
    $seen = 0;
    while ($r && ($row = $r->fetch_assoc())) {
        $seen++;
        if ((int)$row['a'] !== 1) {
            reset_fail('verify auto_increment ' . $row['t'], 'data_reset_auto_increment_pending');
        }
    }
    if ($seen !== 2) {
        reset_fail('verify auto_increment', 'unknown');
    }

    $r = $db->query('SELECT id, name, unit_price, stock_quantity FROM products ORDER BY id');
    $checked = 0;
    while ($r && ($row = $r->fetch_assoc())) {
        $pid = (int)$row['id'];
        if (!isset($seed_products[$pid]) || $row['name'] !== $seed_products[$pid][0] || (int)$row['unit_price'] !== $seed_products[$pid][1] || (int)$row['stock_quantity'] !== $seed_products[$pid][2]) {
            reset_fail('verify products', 'unknown');
        }
        $checked++;
    }
    if ($checked !== count($seed_products)) {
        reset_fail('verify products', 'unknown');
    }

    json_success(array(
        'orders_deleted'      => $deleted_orders,
        'order_lines_deleted' => $deleted_lines,
        'products_restored'   => count($seed_products),
    ));
}