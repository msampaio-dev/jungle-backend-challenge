#!/bin/bash
# Cria a fila principal e a DLQ quando o LocalStack fica pronto.
set -euo pipefail

DLQ_URL=$(awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true \
  --query QueueUrl --output text)

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url "$DLQ_URL" \
  --attribute-names QueueArn \
  --query Attributes.QueueArn --output text)

# maxReceiveCount=5: depois da 5ª entrega sem ack a mensagem vai para a DLQ.
# VisibilityTimeout=30: tempo que a mensagem fica invisível enquanto um worker processa.
awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes "{
    \"FifoQueue\": \"true\",
    \"VisibilityTimeout\": \"30\",
    \"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"
  }"

# Eventos de integração publicados pela outbox. FIFO agrupada por wallet
# (MessageGroupId); a deduplicação por eventId é otimização, não garantia.
awslocal sqs create-queue   --queue-name wagering-events.fifo   --attributes FifoQueue=true

echo "filas SQS criadas"
