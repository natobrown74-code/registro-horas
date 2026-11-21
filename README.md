# Registro de Horas

Aplicación web para que los trabajadores fichen su entrada y salida desde el celular, y para que el administrador vea, corrija y exporte las horas.

## Cómo arrancarla en tu computadora

Necesitas [Node.js](https://nodejs.org) versión 22.13 o más nueva. No hay que instalar nada más.

```bash
npm start
```

Abre http://localhost:3000. La primera vez te pedirá crear la cuenta de administrador (correo + contraseña).

## Configuración (variables de entorno)

| Variable | Para qué sirve | Por defecto |
|---|---|---|
| `PORT` | Puerto del servidor | `3000` |
| `APP_TZ` | Zona horaria del negocio, p. ej. `America/Mexico_City`, `Europe/Madrid` | la del servidor |
| `APP_CURRENCY` | Símbolo de moneda | `₪` |
| `APP_NAME` | Nombre que aparece arriba | `Registro de Horas` |
| `DB_PATH` | Archivo de la base de datos | `data/horas.db` |
| `SETUP_CODE` | Código secreto que se pide al crear el administrador (**úsalo al publicarla en internet**) | (sin código) |
| `COOKIE_SECURE` | Pon `1` cuando la app esté en HTTPS | (apagado) |

> Importante: al publicarla en un servidor, define siempre `APP_TZ` con tu zona horaria; los servidores en la nube suelen estar en UTC.

## Publicarla en internet

Sirve cualquier servicio que ejecute Node.js y tenga **disco persistente** (Render, Railway, Fly.io, un VPS…):

1. Sube esta carpeta a un repositorio de GitHub.
2. Crea el servicio con el comando `npm start`.
3. Monta un disco persistente y apunta `DB_PATH` a él (p. ej. `/data/horas.db`).
4. Define `APP_TZ`, `SETUP_CODE` y `COOKIE_SECURE=1`.
5. Haz copias de seguridad del archivo `.db` (o del disco) periódicamente.

## Qué incluye esta versión

- **Trabajador** (usuario + PIN de 4 números): solo consulta. Ve sus horas (hoy, semana, quincena, mes) y lo que ha ganado en el mes hasta hoy. No puede marcar entrada ni salida ni cambiar horas: todo lo registra el administrador.
- **Pago**: cada trabajador tiene un pago por día (jornada de 8 horas). Si trabaja menos, se paga la parte proporcional. Cada hora que pase de 8 en un día se paga como hora extra: el precio lo fija el administrador o, si lo deja vacío, es la hora normal + 50 %. Moneda: shekel (₪).
- **Administrador** (correo + contraseña): alta, edición y desactivación de trabajadores; tabla de horas por día, semana, quincena o mes, filtrable por trabajador; horas por día; totales y pago estimado; añadir / corregir / borrar registros; alertas de quien entró y no marcó salida.
- **Reportes**: exportar a Excel (.xlsx con hojas «Resumen» y «Detalle») e imprimir / guardar como PDF el resumen para nómina (con columna de firma).
- **Seguridad**: PIN y contraseña cifrados, bloqueo de 5 minutos tras 5 intentos fallidos, sesiones en el servidor, cada trabajador solo puede ver lo suyo, no se permiten registros que se crucen ni dos entradas abiertas.

## Estructura

- `server.js` — servidor, API y base de datos (SQLite incluido en Node).
- `public/` — la interfaz (HTML, CSS y JavaScript).

## Paleta de colores

Todos los colores están definidos una sola vez como variables `--color-*` al inicio de `public/styles.css`; el resto de la hoja solo usa esas variables. Para cambiar el color de la marca basta con editar `--color-primary` y `--color-primary-dark`.

| Nombre | Variable | Hex | Uso | Contraste con blanco |
|---|---|---|---|---|
| Primario | `--color-primary` | `#1E40AF` | Botón principal, pestaña activa, foco | 8.7:1 |
| Primario oscuro | `--color-primary-dark` | `#1E3A8A` | Hover / pulsado | 10.4:1 |
| Primario claro | `--color-primary-light` | `#DBEAFE` | Fondos suaves | — |
| Secundario | `--color-secondary` | `#475569` | Elementos de apoyo | 7.6:1 |
| Acento | `--color-accent` | `#0EA5E9` | Solo decorativo (no para texto) | 2.8:1 |
| Fondo | `--color-background` | `#F8FAFC` | Fondo de página | — |
| Superficie | `--color-surface` | `#FFFFFF` | Tarjetas y ventanas | — |
| Texto | `--color-text-primary` | `#0F172A` | Títulos y texto principal | 17.9:1 |
| Texto secundario | `--color-text-secondary` | `#475569` | Etiquetas y ayudas | 7.6:1 |
| Texto atenuado | `--color-text-muted` | `#64748B` | Notas | 4.8:1 |
| Borde | `--color-border` | `#E2E8F0` | Bordes y separadores | — |
| Éxito | `--color-success` | `#15803D` | Botón ENTRAR, «Activo», «Reloj» | 5.0:1 |
| Aviso | `--color-warning` | `#A16207` | Etiqueta «Manual» | 4.9:1 |
| Error | `--color-error` | `#B91C1C` | Botón SALIR, alertas, borrar | 6.5:1 |
| Información | `--color-info` | `#1D4ED8` | Etiqueta «Admin» | 6.7:1 |

Cada color semántico tiene además variantes `-bg` (fondo suave) y `-border`.

Decisiones:
- Se usa la paleta «Profesional / Corporativa» de la guía de colores: mayormente neutros, con el azul solo en acciones clave.
- En los colores semánticos se usa el tono 700 (más oscuro que los valores de ejemplo de la guía, como `#22C55E`), porque los tonos 500 no llegan al contraste mínimo 4.5:1 con texto blanco.
- El color nunca es la única señal: estados y alertas siempre llevan texto.
