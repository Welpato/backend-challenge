#!/usr/bin/env bash
# Cria as filas FIFO do desafio. Executado pelo LocalStack em /etc/localstack/init/ready.d/
# (com `awslocal`). Fora do container: AWS_CMD="aws --endpoint-url http://localhost:4566" ./docker/localstack-init.sh
# `create-queue` é idempotente quando os atributos são iguais, então o script pode rodar de novo.
set -euo pipefail

AWS_CMD="${AWS_CMD:-awslocal}"
WAGER_QUEUE="${SQS_WAGER_QUEUE_NAME:-wager-transactions.fifo}"
WAGER_DLQ="${SQS_WAGER_DLQ_NAME:-wager-transactions-dlq.fifo}"
EVENTS_QUEUE="${SQS_EVENTS_QUEUE_NAME:-wallet-events.fifo}"
VISIBILITY_TIMEOUT="${SQS_VISIBILITY_TIMEOUT_SECONDS:-30}"
MAX_RECEIVE_COUNT="${SQS_MAX_RECEIVE_COUNT:-5}"
RETENTION_SECONDS=1209600 # 14 dias (máximo do SQS) para a DLQ e a fila de eventos

sqs() {
  # shellcheck disable=SC2086 # AWS_CMD pode conter argumentos (--endpoint-url ...)
  ${AWS_CMD} sqs "$@"
}

create_queue() {
  local name="$1" attributes="$2"
  sqs create-queue --queue-name "${name}" --attributes "${attributes}" --query QueueUrl --output text
}

dlq_url="$(create_queue "${WAGER_DLQ}" \
  "{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"false\",\"MessageRetentionPeriod\":\"${RETENTION_SECONDS}\"}")"
dlq_arn="$(sqs get-queue-attributes --queue-url "${dlq_url}" --attribute-names QueueArn --query Attributes.QueueArn --output text)"

redrive_policy="{\\\"deadLetterTargetArn\\\":\\\"${dlq_arn}\\\",\\\"maxReceiveCount\\\":\\\"${MAX_RECEIVE_COUNT}\\\"}"
create_queue "${WAGER_QUEUE}" \
  "{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"false\",\"VisibilityTimeout\":\"${VISIBILITY_TIMEOUT}\",\"RedrivePolicy\":\"${redrive_policy}\"}" >/dev/null

# Criada por último: o healthcheck do container espera por ela para considerar o init concluído.
create_queue "${EVENTS_QUEUE}" \
  "{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"false\",\"MessageRetentionPeriod\":\"${RETENTION_SECONDS}\"}" >/dev/null

echo "SQS queues ready: ${WAGER_QUEUE} (redrive -> ${WAGER_DLQ}, maxReceiveCount=${MAX_RECEIVE_COUNT}), ${EVENTS_QUEUE}"
