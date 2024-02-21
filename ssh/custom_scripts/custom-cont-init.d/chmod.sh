#!/bin/bash
echo "-------- Change mode with keys --------"
chmod 400 /config/ssh_host_keys/*_key
chmod 644 /config/ssh_host_keys/*_key.pub
echo "-------- Change mode with custom-cont-init.d --------"
chmod 755 /custom-cont-init.d/*
