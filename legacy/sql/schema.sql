SET NAMES utf8mb4;
SET foreign_key_checks = 0;

CREATE TABLE IF NOT EXISTS customers (
    id   INT UNSIGNED NOT NULL AUTO_INCREMENT,
    name VARCHAR(255) NOT NULL,
    PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS products (
    id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
    name           VARCHAR(255) NOT NULL,
    unit_price     INT UNSIGNED NOT NULL,
    stock_quantity INT UNSIGNED NOT NULL,
    PRIMARY KEY (id),
    CONSTRAINT chk_unit_price     CHECK (unit_price     BETWEEN 1 AND 9999999),
    CONSTRAINT chk_stock_quantity CHECK (stock_quantity <= 999999)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS orders (
    id           INT UNSIGNED                          NOT NULL AUTO_INCREMENT,
    customer_id  INT UNSIGNED                          NOT NULL,
    status       ENUM('pending','shipped','cancelled') NOT NULL DEFAULT 'pending',
    subtotal     INT UNSIGNED                          NOT NULL,
    discount     INT UNSIGNED                          NOT NULL,
    shipping_fee INT UNSIGNED                          NOT NULL,
    total        INT UNSIGNED                          NOT NULL,
    created_at   DATETIME                              NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS order_lines (
    id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
    order_id   INT UNSIGNED NOT NULL,
    product_id INT UNSIGNED NOT NULL,
    quantity   INT UNSIGNED NOT NULL,
    unit_price INT UNSIGNED NOT NULL,
    PRIMARY KEY (id),
    CONSTRAINT fk_order_lines_order   FOREIGN KEY (order_id)   REFERENCES orders(id),
    CONSTRAINT fk_order_lines_product FOREIGN KEY (product_id) REFERENCES products(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX idx_order_lines_order_id   ON order_lines (order_id);
CREATE INDEX idx_order_lines_product_id ON order_lines (product_id);

SET foreign_key_checks = 1;
