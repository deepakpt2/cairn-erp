#!/bin/sh
set -eu

if [ -z "${BUILD_BOX_PASSWORD:-}" ]; then
  echo 'BUILD_BOX_PASSWORD is required.' >&2
  exit 1
fi
case "$BUILD_BOX_PASSWORD" in
  *[!A-Za-z0-9_-]*)
    echo 'Use a URL-safe BUILD_BOX_PASSWORD (letters, digits, underscore, hyphen).' >&2
    exit 1
    ;;
esac

echo "cairn:${BUILD_BOX_PASSWORD}" | chpasswd
install -d -o postgres -g postgres -m 755 /var/run/postgresql
install -d -o root -g root -m 755 /run/sshd
if [ ! -d /var/lib/postgresql/17/main ]; then
  pg_createcluster 17 main -- --auth-local=peer --auth-host=scram-sha-256
fi
install -d /etc/postgresql/17/main/conf.d
cat > /etc/postgresql/17/main/conf.d/build-box.conf <<'EOF'
listen_addresses = '127.0.0.1'
port = 5432
password_encryption = 'scram-sha-256'
EOF
pg_ctlcluster 17 main start
node /usr/local/bin/bootstrap-db.mjs
ssh-keygen -A
echo 'sshd is listening on 2222.'
exec /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config.build-box
