# Despliegue

Notas de operación para el despliegue del paso 12. El `docker-compose.yml` de la raíz es solo para desarrollo y pruebas (PostgreSQL).

## Una sola instancia activa (C5, D47)

- La estrategia de despliegue debe ser **recreate** (detener la instancia vieja y luego arrancar la nueva), **no rolling**.
- Si por error arranca una segunda réplica contra la misma base, **no corrompe nada**: solo la instancia que tiene el *lease* (`instance_lease`) ejecuta la recuperación tras una caída, los carriles de trabajos y los ciclos periódicos. La otra sirve HTTP y queda en espera; toma el relevo sola si la primera muere (a más tardar `INSTANCE_LEASE_TTL_SECONDS` después de su última renovación). `GET /instance` (con JWT) dice qué rol tiene la instancia que respondió.
- Los comandos del operador sobre lotes se serializan dentro de un proceso (`SerialExecutor`); con dos instancias atendiendo HTTP, las versiones optimistas (D37) y el manifiesto de solo inserción impiden que se pisen, pero el diseño sigue siendo de **una** instancia: la segunda solo se tolera.

## Apagado (D33)

El proceso espera hasta `SHUTDOWN_TIMEOUT_SECONDS` (25 s) a que el lote en curso termine el soporte que está enviando y se detenga como `INTERRUPTED`. El periodo de gracia del contenedor debe ser mayor (Docker da 10 s por defecto):

```yaml
services:
  bulk-mailer:
    image: bulk-mailer-backend:latest
    env_file: .env
    volumes:
      - receipts:/data
    stop_grace_period: 40s
    deploy:
      replicas: 1
      update_config:
        order: stop-first   # recreate: never two instances at once on purpose
```

## CORS (D49)

En producción `CORS_ALLOWED_ORIGINS` es obligatorio: el origen exacto del cliente web (`https://host[:puerto]`), nunca `*`.
