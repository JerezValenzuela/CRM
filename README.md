# CRM — Clientes por Monto Total

Módulo de ranking de clientes basado en ventas acumuladas. Desarrollado con Vite + React + TypeScript.

## Archivo Excel requerido

Usa el reporte **"Informe de Facturas por Cliente #6"** exportado desde el sistema de contabilidad.

- Formato: `.xlsx` o `.xls`
- Los datos deben comenzar en la **fila 10**
- Columnas utilizadas:
  - **A** — Fecha
  - **B** — Nº de Factura / Nota
  - **C** — Cliente
  - **D** — Monto
- El sistema detecta automáticamente las secciones del archivo:
  - Notas de Venta
  - Facturas
  - Descuentos
- Usa el selector de tipo para filtrar por sección o combinarlas

## Cómo usar

1. Abre la app en `http://localhost:5173`
2. Selecciona el tipo de documento a analizar
3. Arrastra el archivo Excel o haz clic en **Seleccionar Archivo**
4. Usa el filtro por monto si necesitas segmentar el ranking
5. Descarga el reporte en CSV con el botón **Descargar Reporte**

## Instalación

```bash
npm install
npm run dev
```
