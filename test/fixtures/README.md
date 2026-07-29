# Orders API

Public REST API that accepts and orchestrates customer orders for Acme.

This README lives beside the service code and is referenced *in place* by the
Dependra manifest (`.dependra/manifest.yaml`) as the `documentation` field of
the `orders-api` component — so the architecture docs and the code stay in one
source of truth.

## Run

```bash
dotnet run
```

## Contract

The service publishes `orders.lifecycle` events to Kafka and reads/writes the
managed orders database. See `.dependra/docs/orders.md` for the platform-level
overview.
