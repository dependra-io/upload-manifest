# Orders Platform

The Orders Platform is Acme's revenue-critical order-capture and fulfilment
system. It accepts orders through a public API, persists them to a managed
PostgreSQL store, and publishes lifecycle events to a Kafka topic for
downstream fulfilment, billing, and analytics consumers.

## Why it matters

Orders is **mission-critical**: an outage stops all revenue capture. Its blast
radius reaches billing, fulfilment, and customer notifications.

## Data

Orders carries **Financial** and PII-adjacent data. All transport is encrypted
(TLS 1.3), and the database is reachable only from within the private network.
