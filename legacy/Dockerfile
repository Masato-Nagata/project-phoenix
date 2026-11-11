FROM php:5.6-apache

# Install mysqli extension
RUN docker-php-ext-install mysqli

# Create non-root user
RUN groupadd -g 1000 appuser \
 && useradd -u 1000 -g appuser -s /sbin/nologin -d /var/www appuser

# PHP configuration: restrict outbound capabilities and hide errors from responses
RUN { \
    echo "allow_url_fopen = Off"; \
    echo "allow_url_include = Off"; \
    echo "disable_functions = fsockopen,socket_create,socket_connect,curl_init,curl_exec"; \
    echo "display_errors = Off"; \
    echo "log_errors = On"; \
    echo "error_log = /dev/stderr"; \
} >> /usr/local/etc/php/php.ini

# Enable Apache rewrite module
RUN a2enmod rewrite

# Disable the status module (it exposes /server-status)
RUN a2dismod status

# Switch to non-root user before exposing port
USER appuser

EXPOSE 80
