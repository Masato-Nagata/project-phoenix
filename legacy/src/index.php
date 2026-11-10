<?php
require_once __DIR__ . '/utils.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/products.php';
require_once __DIR__ . '/orders.php';

$method = $_SERVER['REQUEST_METHOD'];
$uri    = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$uri    = rtrim($uri, '/');

if ($method === 'GET' && $uri === '/health') {
    if ($db === null) {
        json_success(array('app' => 'ok', 'db' => 'error'), 503);
    }
    $r = $db->query('SELECT 1');
    if ($r === false) {
        json_success(array('app' => 'ok', 'db' => 'error'), 503);
    }
    json_success(array('app' => 'ok', 'db' => 'ok'));
}

if ($method === 'POST' && $uri === '/reset') {
    reset_db();
}

if ($method === 'GET' && $uri === '/products') {
    list_products();
}

if ($method === 'GET' && preg_match('#^/products/(\d+)$#', $uri, $m)) {
    get_product($m[1]);
}

if ($method === 'POST' && $uri === '/orders') {
    place_order(file_get_contents('php://input'));
}

if ($method === 'GET' && $uri === '/orders') {
    list_orders();
}

if ($method === 'GET' && preg_match('#^/orders/(\d+)$#', $uri, $m)) {
    get_order($m[1]);
}

if ($method === 'POST' && preg_match('#^/test/orders/(\d+)/ship$#', $uri, $m)) {
    ship_order($m[1]);
}

if ($method === 'POST' && preg_match('#^/orders/(\d+)/cancel$#', $uri, $m)) {
    cancel_order($m[1]);
}

json_error('Not Found', 404);
