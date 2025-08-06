#!/bin/bash

CONFIG_FILE="/config/sshd/sshd_config"

echo "--- Setting up SSHD configuration..."
# Set SSHD configuration options
sed -i 's/#*AllowTcpForwarding.*/AllowTcpForwarding yes/' "$CONFIG_FILE"
sed -i 's/#*GatewayPorts.*/GatewayPorts no/' "$CONFIG_FILE"
sed -i 's/#*X11Forwarding.*/X11Forwarding yes/' "$CONFIG_FILE"

# Add custom configuration for user 'telepy'
cat >> "$CONFIG_FILE" << 'EOF'

Match User telepy
  AllowTcpForwarding yes
  PermitTunnel yes
  ForceCommand echo 'This account can only be used for reverse SSH tunneling'
EOF

echo "--- SSHD configuration updated successfully."