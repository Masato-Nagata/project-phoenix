<?php
function list_products() {
    global $db;
    $result = $db->query('SELECT id, name, unit_price, stock_quantity FROM products ORDER BY id');
    $products = array();
    while ($row = $result->fetch_assoc()) {
        $products[] = array(
            'id'             => (int)$row['id'],
            'name'           => $row['name'],
            'unit_price'     => (int)$row['unit_price'],
            'stock_quantity' => (int)$row['stock_quantity'],
        );
    }
    json_success($products);
}

function get_product($id) {
    global $db;
    $id = (int)$id;
    if ($id <= 0) {
        json_error('Invalid product id', 400);
    }
    $stmt = $db->prepare('SELECT id, name, unit_price, stock_quantity FROM products WHERE id = ?');
    $stmt->bind_param('i', $id);
    $stmt->execute();
    $result = $stmt->get_result();
    $row = $result->fetch_assoc();
    if (!$row) {
        json_error('Product not found', 404);
    }
    json_success(array(
        'id'             => (int)$row['id'],
        'name'           => $row['name'],
        'unit_price'     => (int)$row['unit_price'],
        'stock_quantity' => (int)$row['stock_quantity'],
    ));
}
