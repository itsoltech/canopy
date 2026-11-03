FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server curl ca-certificates coreutils procps \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -s /bin/sh canopy && passwd -d canopy \
    && mkdir -p /run/sshd /home/canopy/.ssh \
    && chmod 700 /home/canopy/.ssh && chown -R canopy:canopy /home/canopy
# No systemd runs in this container. The explicit test shim records activation and starts
# the real binary; generated unit contents are asserted by the integration test.
COPY systemctl /usr/local/bin/systemctl
RUN chmod 755 /usr/local/bin/systemctl
CMD ["sh", "-c", "ssh-keygen -A && exec /usr/sbin/sshd -D -e -o PasswordAuthentication=no -o PermitEmptyPasswords=no -o AllowUsers=canopy"]
