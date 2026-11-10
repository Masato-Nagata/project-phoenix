<?php
$db = new mysqli(
    getenv('DB_HOST') ?: 'localhost',
    getenv('DB_USER') ?: 'root',
    getenv('DB_PASS') ?: '',
    getenv('DB_NAME') ?: 'legacy_orders',
    (int)(getenv('DB_PORT') ?: 3306)
);

if ($db->connect_errno) {
    $db = null;
}
