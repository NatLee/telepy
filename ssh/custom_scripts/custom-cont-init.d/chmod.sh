#!/bin/bash
echo "-------- Change mode with keys"
chmod 400 /config/ssh_host_keys/*_key
chmod 644 /config/ssh_host_keys/*_key.pub

chmod 755 /custom-cont-init.d/*
