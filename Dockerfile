FROM python:3.11.8-slim-bullseye

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
COPY ./src /src
RUN chmod +x /src/docker-entrypoint.sh

ENTRYPOINT ["bash", "/src/docker-entrypoint.sh"]
