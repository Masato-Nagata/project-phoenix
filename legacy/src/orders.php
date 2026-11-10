<?php
function place_order($body) {
    global $db;

    $data = json_decode($body, true);
    if (!isset($data['customer_id']) || !isset($data['lines']) || !is_array($data['lines']) || count($data['lines']) === 0) {
        json_error('Invalid request', 400);
    }
    if (count($data['lines']) > 100) {
        json_error('Invalid request', 400);
    }

    $customer_id = (int)$data['customer_id'];
    $stmt = $db->prepare('SELECT id FROM customers WHERE id = ?');
    $stmt->bind_param('i', $customer_id);
    $stmt->execute();
    if ($stmt->get_result()->num_rows === 0) {
        json_error('Customer not found', 404);
    }

    $product_ids = array();
    foreach ($data['lines'] as $line) {
        $product_ids[] = (int)$line['product_id'];
    }
    $placeholders = implode(',', array_fill(0, count($product_ids), '?'));
    $types = str_repeat('i', count($product_ids));
    $stmt = $db->prepare('SELECT id, unit_price, stock_quantity FROM products WHERE id IN (' . $placeholders . ')');
    $stmt->bind_param($types, ...$product_ids);
    $stmt->execute();
    $res = $stmt->get_result();
    $products_map = array();
    while ($row = $res->fetch_assoc()) {
        $products_map[(int)$row['id']] = array(
            'unit_price'     => (int)$row['unit_price'],
            'stock_quantity' => (int)$row['stock_quantity'],
        );
    }

    $unknown = array();
    foreach ($product_ids as $pid) {
        if (!isset($products_map[$pid])) {
            $unknown[] = $pid;
        }
    }
    if (!empty($unknown)) {
        json_error('Unknown products', 400, array('product_ids' => $unknown));
    }

    $subtotal = 0;
    foreach ($data['lines'] as $line) {
        $subtotal += $products_map[(int)$line['product_id']]['unit_price'] * (int)$line['quantity'];
    }

    if ($subtotal < 1000) {
        json_error('Minimum order value not met', 400);
    }

    $insufficient = array();
    foreach ($data['lines'] as $line) {
        $pid = (int)$line['product_id'];
        $qty = (int)$line['quantity'];
        if ($products_map[$pid]['stock_quantity'] < $qty) {
            $insufficient[] = array('product_id' => $pid, 'available' => $products_map[$pid]['stock_quantity'], 'requested' => $qty);
        }
    }
    if (!empty($insufficient)) {
        json_error('Insufficient stock', 409, array('products' => $insufficient));
    }

    if ($subtotal < 3000) {
        $discount = 0;
    } elseif ($subtotal <= 9999) {
        $discount = 300;
    } else {
        $discount = 1000;
    }

    $net_amount = $subtotal - $discount;

    if ($net_amount < 5000) {
        $shipping_fee = 500;
    } else {
        $shipping_fee = 0;
    }

    $total = $subtotal - $discount + $shipping_fee;

    $db->begin_transaction();

    $stmt = $db->prepare('SELECT id, stock_quantity FROM products WHERE id IN (' . $placeholders . ') FOR UPDATE');
    $stmt->bind_param($types, ...$product_ids);
    $stmt->execute();
    $res = $stmt->get_result();
    $locked_stock = array();
    while ($row = $res->fetch_assoc()) {
        $locked_stock[(int)$row['id']] = (int)$row['stock_quantity'];
    }

    foreach ($data['lines'] as $line) {
        $pid = (int)$line['product_id'];
        $qty = (int)$line['quantity'];
        if ($locked_stock[$pid] < $qty) {
            $db->rollback();
            json_error('Insufficient stock', 409, array('products' => array(array('product_id' => $pid, 'available' => $locked_stock[$pid], 'requested' => $qty))));
        }
    }

    $stmt = $db->prepare('INSERT INTO orders (customer_id, status, subtotal, discount, shipping_fee, total) VALUES (?, \'pending\', ?, ?, ?, ?)');
    $stmt->bind_param('iiiii', $customer_id, $subtotal, $discount, $shipping_fee, $total);
    if (!$stmt->execute()) {
        $db->rollback();
        json_error('Internal error', 500);
    }
    $order_id = $db->insert_id;

    $stmt_line = $db->prepare('INSERT INTO order_lines (order_id, product_id, quantity, unit_price) VALUES (?, ?, ?, ?)');
    foreach ($data['lines'] as $line) {
        $pid = (int)$line['product_id'];
        $qty = (int)$line['quantity'];
        $up  = $products_map[$pid]['unit_price'];
        $stmt_line->bind_param('iiii', $order_id, $pid, $qty, $up);
        if (!$stmt_line->execute()) {
            $db->rollback();
            json_error('Internal error', 500);
        }
    }

    $upd = $db->prepare('UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ? AND stock_quantity >= ?');
    foreach ($data['lines'] as $line) {
        $pid = (int)$line['product_id'];
        $qty = (int)$line['quantity'];
        $upd->bind_param('iii', $qty, $pid, $qty);
        if (!$upd->execute() || $upd->affected_rows === 0) {
            $db->rollback();
            json_error('Insufficient stock', 409);
        }
    }

    $db->commit();

    json_success(array(
        'order_id'     => $order_id,
        'subtotal'     => $subtotal,
        'discount'     => $discount,
        'shipping_fee' => $shipping_fee,
        'total'        => $total,
    ), 201);
}

function cancel_order($id) {
    global $db;
    $id = (int)$id;
    if ($id <= 0) {
        json_error('Invalid order id', 400);
    }
    $stmt = $db->prepare('SELECT id, status FROM orders WHERE id = ?');
    $stmt->bind_param('i', $id);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    if (!$row) {
        json_error('Order not found', 404);
    }
    if ($row['status'] === 'cancelled') {
        json_error('Order is already cancelled', 409);
    }
    if ($row['status'] === 'shipped') {
        json_error('Order cannot be cancelled', 409);
    }

    $stmt = $db->prepare('SELECT product_id, quantity FROM order_lines WHERE order_id = ?');
    $stmt->bind_param('i', $id);
    $stmt->execute();
    $lines = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);

    $db->begin_transaction();

    $stmt = $db->prepare('UPDATE orders SET status = \'cancelled\' WHERE id = ?');
    $stmt->bind_param('i', $id);
    if (!$stmt->execute()) {
        $db->rollback();
        json_error('Internal error', 500);
    }

    $upd = $db->prepare('UPDATE products SET stock_quantity = stock_quantity + ? WHERE id = ?');
    foreach ($lines as $line) {
        $qty = (int)$line['quantity'];
        $pid = (int)$line['product_id'];
        $upd->bind_param('ii', $qty, $pid);
        if (!$upd->execute()) {
            $db->rollback();
            json_error('Internal error', 500);
        }
    }
    $db->commit();

    $pids = array_column($lines, 'product_id');
    $ph   = implode(',', array_fill(0, count($pids), '?'));
    $tp   = str_repeat('i', count($pids));
    $stmt = $db->prepare('SELECT id, stock_quantity FROM products WHERE id IN (' . $ph . ') ORDER BY id');
    $stmt->bind_param($tp, ...$pids);
    $stmt->execute();
    $res = $stmt->get_result();
    $restored = array();
    while ($r = $res->fetch_assoc()) {
        $restored[] = array('product_id' => (int)$r['id'], 'stock_quantity' => (int)$r['stock_quantity']);
    }

    json_success(array('order_id' => $id, 'restored_stock' => $restored));
}

function list_orders() {
    global $db;
    $result = $db->query('SELECT id, customer_id, status, subtotal, discount, shipping_fee, total, created_at FROM orders ORDER BY id');
    $orders = array();
    while ($row = $result->fetch_assoc()) {
        $orders[] = array(
            'id'           => (int)$row['id'],
            'customer_id'  => (int)$row['customer_id'],
            'status'       => $row['status'],
            'subtotal'     => (int)$row['subtotal'],
            'discount'     => (int)$row['discount'],
            'shipping_fee' => (int)$row['shipping_fee'],
            'total'        => (int)$row['total'],
            'created_at'   => date('Y-m-d\TH:i:sP', strtotime($row['created_at'])),
        );
    }
    json_success($orders);
}

function get_order($id) {
    global $db;
    $id = (int)$id;
    if ($id <= 0) {
        json_error('Invalid order id', 400);
    }
    $stmt = $db->prepare('SELECT id, customer_id, status, subtotal, discount, shipping_fee, total, created_at FROM orders WHERE id = ?');
    $stmt->bind_param('i', $id);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    if (!$row) {
        json_error('Order not found', 404);
    }
    $order = array(
        'id'           => (int)$row['id'],
        'customer_id'  => (int)$row['customer_id'],
        'status'       => $row['status'],
        'subtotal'     => (int)$row['subtotal'],
        'discount'     => (int)$row['discount'],
        'shipping_fee' => (int)$row['shipping_fee'],
        'total'        => (int)$row['total'],
        'created_at'   => date('Y-m-d\TH:i:sP', strtotime($row['created_at'])),
    );
    $stmt = $db->prepare('SELECT product_id, quantity, unit_price FROM order_lines WHERE order_id = ? ORDER BY id');
    $stmt->bind_param('i', $id);
    $stmt->execute();
    $lines = array();
    $res = $stmt->get_result();
    while ($l = $res->fetch_assoc()) {
        $lines[] = array(
            'product_id' => (int)$l['product_id'],
            'quantity'   => (int)$l['quantity'],
            'unit_price' => (int)$l['unit_price'],
        );
    }
    $order['lines'] = $lines;
    json_success($order);
}

function ship_order($id) {
    global $db;
    $id = (int)$id;
    if ($id <= 0) {
        json_error('Invalid order id', 400);
    }
    $stmt = $db->prepare('SELECT id, status FROM orders WHERE id = ?');
    $stmt->bind_param('i', $id);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    if (!$row) {
        json_error('Order not found', 404);
    }
    if ($row['status'] === 'shipped') {
        json_error('Order is already shipped', 409);
    }
    if ($row['status'] === 'cancelled') {
        json_error('Order cannot be shipped: already cancelled', 409);
    }
    $stmt = $db->prepare("UPDATE orders SET status = 'shipped' WHERE id = ?");
    $stmt->bind_param('i', $id);
    if (!$stmt->execute()) {
        json_error('Internal error', 500);
    }
    json_success(array('order_id' => $id, 'status' => 'shipped'));
}
