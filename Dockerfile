FROM python:3.11.8-slim-bullseye

ENV PYTHONUNBUFFERED 1

WORKDIR /src
COPY requirements.txt /src
RUN pip install -r requirements.txt

COPY ./src /src
RUN chmod +x /src/docker-entrypoint.sh

RUN apt-get update
RUN apt-get install -y ssh

ENTRYPOINT ["bash", "/src/docker-entrypoint.sh"]