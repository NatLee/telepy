# Telepy

> Only support Linux-based machine.

A web application for managing and monitoring the reverse SSH tunnels.

## Usage

1. Generate keys for SSH server.

```bash
bash dev-keygen.sh
```

2. Build and run the Docker container.

```bash
docker-compose up
```

3. Create a superuser for Django admin.

> Check the script `./dev-create-superuser.sh` and change the username and password if you want.

```bash
bash dev-create-superuser.sh
```

4. Go to http://localhost:8787, it will show the login page.

## License

[MIT](./LICENSE)

