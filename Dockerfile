# Django 6.0 需 Python 3.12+（3.11 為 Django 5.2 LTS 最後支援版本）。
# Django 6.0 requires Python 3.12+ (3.11 was last supported by Django 5.2 LTS).
FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED 1

# Install system dependencies
# For debugging purposes
RUN apt-get update
RUN apt-get install -y -qq iputils-ping procps
RUN apt-get install -y -qq curl
RUN apt-get install -y -qq ssh redis zip

# Install dependencies
WORKDIR /src
COPY requirements.txt /src
RUN pip install -r requirements.txt

# Copy project
COPY ./src/backend /src
RUN chmod +x /src/docker-entrypoint.sh

WORKDIR /src
ENTRYPOINT ["bash", "/src/docker-entrypoint.sh"]
