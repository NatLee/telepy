# Telepy

> Only support Linux-based machine.

A web application for managing and monitoring the reverse SSH tunnels.

## Usage

1. Copy the `.env.example` to `.env` and change the environment variables.

2. Generate keys for SSH server.

```bash
bash dev-keygen.sh
```

3. Build and run the Docker container.

```bash
docker-compose up
```

4. Create a superuser for Django admin.

> Check the script `./dev-create-superuser.sh` and change the username and password if you want.

```bash
bash dev-create-superuser.sh
```

5. Go to `http://localhost:<YOUR_WEB_SERVER_PORT>/login`, it will show the login page.

## API Documentation

If you want to see the API documentation, you need to login first.

1. Go to `http://localhost:<YOUR_WEB_SERVER_PORT>/api/__hidden_admin/` and login with the superuser.

2. Go to `http//localhost:<YOUR_WEB_SERVER_PORT>/api/__hidden_swagger` and you will see the Swagger.


## License

[MIT](./LICENSE)

