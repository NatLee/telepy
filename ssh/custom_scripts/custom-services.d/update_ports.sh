
REDIS_HOST="telepy-redis"
REDIS_PORT="6379"
REDIS_KEY="ss_output"

while true; do
  echo `ss -tlnp` | redis-cli -h $REDIS_HOST -p $REDIS_PORT -x SET $REDIS_KEY
  sleep 5
done

