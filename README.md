# Telepy

![ui](https://i.imgur.com/tie5vrR.png)
![terminal](https://i.imgur.com/l6bx20q.png)

A web application for managing and monitoring the reverse SSH tunnels.

## Usage

1. Copy the `.env.example` to `.env` and change the environment variables.

2. Generate keys for SSH server.

```bash
./telepy.sh keygen
```

3. Build and run the Docker container.

```bash
docker-compose up
```

4. (Optional) Create a superuser for Django admin.

> Be aware that the first user created will be the superuser whatever the method you use. See [this function](./src/user_management/signals.py) for more details.
> So, if you want to login with Google account, just visit the login page and login with Google account.

You need to check the script `./dev-create-superuser.sh` and change the username and password if you want.

```bash
./telepy.sh create-superuser
```


5. Go to `http://localhost:<YOUR_WEB_SERVER_PORT>/login`, it will show the login page.

## API Documentation

If you want to see the API documentation, you need to login first.

1. Go to `http://localhost:<YOUR_WEB_SERVER_PORT>/api/__hidden_admin/` and login with the superuser.

2. Go to `http//localhost:<YOUR_WEB_SERVER_PORT>/api/__hidden_swagger` and you will see the Swagger.

## Misc

There are some scripts in the `dev-scripts` directory.

You can just use `./telepy.sh` to run the scripts.

```bash
Usage: ./telepy.sh sub-command [args]
Sub-commands:
  keygen: Generate SSH keys for Telepy service.
  create-superuser: Create an admin account for Telepy management.
  shell: Create a shell to run arbitrary command.
  ipython: Create a shell to run ipython.
  supervisorctl: Attach to supervisor control shell.
  ssh-shell: Similar to 'shell', but for ssh container.
  migration: Run migration process.
  backend-debug: Recreate and attach to backend container.
  collect-static: Collect static files to increase rendering speed.
  django-startapp: Create a new Django app.
```


## Contributors

<!-- ALL-CONTRIBUTORS-LIST:START - Do not remove or modify this section -->
<!-- prettier-ignore-start -->
<!-- markdownlint-disable -->
<table>
  <tbody>
    <tr>
      <td align="center"><a href="https://github.com/NatLee"><img src="https://avatars.githubusercontent.com/u/10178964?v=3?s=100" width="100px;" alt="Nat Lee"/><br /><sub><b>Nat Lee</b></sub></a></td>
      <td align="center"><a href="https://github.com/h-alice"><img src="https://avatars.githubusercontent.com/u/16372174?v=3?s=100" width="100px;" alt="H. Alice"/><br /><sub><b>H. Alice</b></sub></a></td>
      <td align="center"><a href="https://github.com/boris-lok"><img src="https://avatars.githubusercontent.com/u/77889460?v=3?s=100" width="100px;" alt="Boris Lok"/><br /><sub><b>Boris Lok</b></sub></a></td>
    </tr>
  </tbody>
</table>

<!-- markdownlint-restore -->
<!-- prettier-ignore-end -->

<!-- ALL-CONTRIBUTORS-LIST:END -->

## License

[MIT](./LICENSE)
