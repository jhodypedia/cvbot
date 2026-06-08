CREATE DATABASE IF NOT EXISTS pansa_bot;
USE pansa_bot;

CREATE TABLE IF NOT EXISTS users (
    telegram_id BIGINT PRIMARY KEY,
    username VARCHAR(100),
    payment_method VARCHAR(50) DEFAULT NULL,
    payment_account VARCHAR(100) DEFAULT NULL,
    account_name VARCHAR(100) DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    telegram_id BIGINT,
    txhash VARCHAR(66) UNIQUE,
    amount_usdt DECIMAL(18, 4),
    rate_idr DECIMAL(18, 2),
    total_idr DECIMAL(18, 2),
    status ENUM('PENDING', 'SUCCESS', 'FAILED') DEFAULT 'PENDING',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
