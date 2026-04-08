import { useState, useRef, useCallback } from "react";
import * as XLSX from "xlsx";
import { Upload, Download, Users, AlertTriangle, RefreshCw, X } from "lucide-react";

// ── Tipos ────────────────────────────────────────────────────────────────────

type TipoDoc = "notas" | "facturas" | "descuentos" | "combinado" | "todo";

interface ClientRow {
  ranking: number;
  cliente: string;
  total: number;
  compras: number;
}

// Una sección detectada en el Excel: { tipo, filas de datos }
interface Seccion {
  tipo: "notas" | "facturas" | "descuentos" | "otro";
  label: string;           // nombre original detectado
  filas: { cliente: string; monto: number }[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function RankBadge({ rank }: { rank: number }) {
  if (rank === 1) return <span style={{ fontSize: 22 }}>🥇</span>;
  if (rank === 2) return <span style={{ fontSize: 22 }}>🥈</span>;
  if (rank === 3) return <span style={{ fontSize: 22 }}>🥉</span>;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      width: 28, height: 28, borderRadius: "50%", backgroundColor: "#E8600A",
      color: "#fff", fontSize: 12, fontWeight: 700, flexShrink: 0,
    }}>
      {rank}
    </span>
  );
}

function fmtMoney(n: number) {
  return n.toLocaleString("es-MX", { style: "currency", currency: "MXN" });
}

/** Clasifica un texto de encabezado de sección */
function clasificarSeccion(texto: string): Seccion["tipo"] {
  const t = texto.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (t.includes("nota") && t.includes("venta")) return "notas";
  if (t.includes("factura")) return "facturas";
  if (t.includes("descuento")) return "descuentos";
  return "otro";
}

/** ¿Es esta fila un encabezado de sección?
 *  Regla: col B tiene texto y col A está vacía O col C empieza con mayúscula larga */
function esEncabezadoSeccion(row: unknown[]): string | null {
  const colA = String(row[0] ?? "").trim();
  const colB = String(row[1] ?? "").trim();
  const colC = String(row[2] ?? "").trim();

  // Patrón 1: A vacío, B tiene texto tipo "Facturas" / "Notas de Venta" / "1. Descuentos"
  if (!colA && colB && colB.length > 2 && !/^\d{1,2}\//.test(colB)) {
    // Descartamos números solos tipo "4,101.47"
    if (!/^[\d,.\s]+$/.test(colB)) return colB;
  }
  // Patrón 2: A vacío, C = "Total:" → fin de sección (no encabezado, lo manejamos abajo)
  // Patrón 3: A vacío, B vacío, C = "Facturas" etc.
  if (!colA && !colB && colC && colC.length > 2 && !/^[\d,.\s]+$/.test(colC)) {
    return colC;
  }
  return null;
}

/** ¿Es una fila de datos válida? A=fecha, B=número factura, C=cliente, D=monto */
function esFila(row: unknown[]): { cliente: string; monto: number } | null {
  const colA = String(row[0] ?? "").trim();
  const colC = String(row[2] ?? "").trim();
  const colD = row[3];

  // A debe tener algo (fecha), C debe ser nombre de cliente (no vacío, no "Total:")
  if (!colA || !colC) return null;
  if (/^total/i.test(colC)) return null;
  if (/^usuario/i.test(colC)) return null;
  if (/^(fecha|nº|n°|numero)/i.test(colC)) return null; // fila de header

  const monto = typeof colD === "number"
    ? colD
    : parseFloat(String(colD ?? "").replace(/[^0-9.-]/g, ""));

  if (isNaN(monto) || monto === 0) return null;

  return { cliente: colC, monto };
}

/** Parsea el sheet completo y devuelve un array de secciones detectadas */
function detectarSecciones(rows: unknown[][]): Seccion[] {
  const secciones: Seccion[] = [];
  let seccionActual: Seccion | null = null;

  for (let i = 9; i < rows.length; i++) {   // desde fila 10 (índice 9)
    const row = rows[i] as unknown[];

    // ¿Fin de sección? (fila con "Total:" en col C y col A vacía)
    const colA = String(row[0] ?? "").trim();
    const colC = String(row[2] ?? "").trim();
    if (!colA && /^total/i.test(colC)) {
      seccionActual = null;
      continue;
    }

    // ¿Encabezado de nueva sección?
    const encabezado = esEncabezadoSeccion(row);
    if (encabezado) {
      seccionActual = {
        tipo: clasificarSeccion(encabezado),
        label: encabezado,
        filas: [],
      };
      secciones.push(seccionActual);
      continue;
    }

    // Si no hay sección activa y llegamos a una fila con datos, creamos sección "notas" implícita
    // (las primeras filas del Excel antes del primer encabezado son Notas de Venta)
    if (!seccionActual) {
      const dato = esFila(row);
      if (dato) {
        seccionActual = { tipo: "notas", label: "Notas de Venta", filas: [] };
        secciones.push(seccionActual);
        seccionActual.filas.push(dato);
      }
      continue;
    }

    // Fila de datos dentro de sección activa
    const dato = esFila(row);
    if (dato) seccionActual.filas.push(dato);
  }

  return secciones.filter(s => s.filas.length > 0);
}

/** Normaliza nombre para usar como clave de agrupación */
function normalizar(nombre: string): string {
  return nombre
    .trim()
    .replace(/\s+/g, " ")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
}

/** Agrupa filas por cliente y devuelve ranking */
function agrupar(filas: { cliente: string; monto: number }[]): ClientRow[] {
  const map = new Map<string, { total: number; compras: number; display: string }>();
  for (const { cliente, monto } of filas) {
    const key = normalizar(cliente);
    const prev = map.get(key) ?? { total: 0, compras: 0, display: cliente.trim() };
    map.set(key, { total: prev.total + monto, compras: prev.compras + 1, display: prev.display });
  }
  return Array.from(map.entries())
    .sort((a, b) => b[1].total - a[1].total)
    .map(([, { total, compras, display }], i) => ({ ranking: i + 1, cliente: display, total, compras }));
}

// ── Opciones de tipo ──────────────────────────────────────────────────────────

const TIPOS: { id: TipoDoc; label: string; desc: string }[] = [
  { id: "notas",      label: "Notas de Venta",         desc: "Solo notas de venta" },
  { id: "facturas",   label: "Facturas",                desc: "Solo facturas" },
  { id: "descuentos", label: "Descuentos",              desc: "Solo descuentos/notas crédito" },
  { id: "combinado",  label: "Notas + Facturas",        desc: "Notas de venta y facturas combinadas" },
  { id: "todo",       label: "Todo",                    desc: "Todas las secciones" },
];

// ── Componente principal ──────────────────────────────────────────────────────

export default function ClientesPage() {
  const [secciones, setSecciones]   = useState<Seccion[]>([]);
  const [tipo, setTipo]             = useState<TipoDoc>("notas");
  const [allClients, setAllClients] = useState<ClientRow[]>([]);
  const [clients, setClients]       = useState<ClientRow[]>([]);
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [dragging, setDragging]     = useState(false);
  const [fileName, setFileName]     = useState<string | null>(null);
  const [filterMin, setFilterMin]   = useState("");
  const [filterMax, setFilterMax]   = useState("");
  const [busqueda, setBusqueda]     = useState("");
  const [updatedAt, setUpdatedAt]   = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Construye el ranking a partir de las secciones detectadas y el tipo seleccionado
  const buildRanking = useCallback((secs: Seccion[], t: TipoDoc) => {
    let filas: { cliente: string; monto: number }[] = [];

    if (t === "todo") {
      filas = secs.flatMap(s => s.filas);
    } else if (t === "combinado") {
      filas = secs.filter(s => s.tipo === "notas" || s.tipo === "facturas").flatMap(s => s.filas);
    } else {
      filas = secs.filter(s => s.tipo === t).flatMap(s => s.filas);
    }

    const ranked = agrupar(filas);
    setAllClients(ranked);
    setClients(ranked);
    setFilterMin("");
    setFilterMax("");
  }, []);

  const parseExcel = useCallback((file: File) => {
    setLoading(true);
    setError(null);
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb   = XLSX.read(e.target?.result, { type: "array", cellDates: true });
        const ws   = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null }) as unknown[][];

        const secs = detectarSecciones(rows);

        if (secs.length === 0) {
          setError("No se encontraron secciones válidas. Verifica el formato del archivo.");
          setLoading(false);
          return;
        }

        setSecciones(secs);
        buildRanking(secs, tipo);
        setUpdatedAt(new Date().toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" }));
      } catch {
        setError("Error al procesar el archivo. Verifica que sea un Excel válido.");
      } finally {
        setLoading(false);
      }
    };
    reader.onerror = () => { setError("No se pudo leer el archivo."); setLoading(false); };
    reader.readAsArrayBuffer(file);
  }, [tipo, buildRanking]);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f && /\.(xlsx|xls|csv)$/i.test(f.name)) { setFileName(f.name); parseExcel(f); }
    else setError("Solo se aceptan archivos .xlsx, .xls o .csv");
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) { setFileName(f.name); parseExcel(f); }
  };

  const handleTipoChange = (t: TipoDoc) => {
    setTipo(t);
    if (secciones.length > 0) buildRanking(secciones, t);
    else { setAllClients([]); setClients([]); }
    setFilterMin(""); setFilterMax("");
  };

  const applyFilter = () => {
    const minVal = filterMin === "" ? -Infinity : parseFloat(filterMin);
    const maxVal = filterMax === "" ?  Infinity : parseFloat(filterMax);
    const q = normalizar(busqueda);
    setClients(
      allClients
        .filter(c => c.total >= minVal && c.total <= maxVal)
        .filter(c => !q || normalizar(c.cliente).includes(q))
        .map((c, i) => ({ ...c, ranking: i + 1 }))
    );
  };

  const clearFilter = () => {
    setFilterMin(""); setFilterMax(""); setBusqueda("");
    setClients(allClients.map((c, i) => ({ ...c, ranking: i + 1 })));
  };

  // Búsqueda en vivo por nombre
  const clientesFiltrados = busqueda
    ? clients.filter(c => normalizar(c.cliente).includes(normalizar(busqueda)))
    : clients;

  const totalGeneral = clientesFiltrados.reduce((s, c) => s + c.total, 0);

  const downloadReport = () => {
    if (!clients.length) return;
    const tipoLabel = TIPOS.find(t => t.id === tipo)?.label ?? tipo;
    const csv = [
      ["#", "Cliente", "Total Vendido", "# de Compras", "Tipo"],
      ...clients.map(c => [c.ranking, `"${c.cliente}"`, c.total.toFixed(2), c.compras, tipoLabel]),
    ].map(r => r.join(",")).join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = `clientes_${tipo}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
  };

  const reset = () => {
    setFileName(null); setSecciones([]); setAllClients([]); setClients([]);
    setFilterMin(""); setFilterMax(""); setError(null); setUpdatedAt(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  // Conteo por tipo para mostrar en los tabs
  const conteo = (t: TipoDoc): number => {
    if (!secciones.length) return 0;
    let filas: { cliente: string; monto: number }[] = [];
    if (t === "todo")      filas = secciones.flatMap(s => s.filas);
    else if (t === "combinado") filas = secciones.filter(s => s.tipo === "notas" || s.tipo === "facturas").flatMap(s => s.filas);
    else filas = secciones.filter(s => s.tipo === t).flatMap(s => s.filas);
    return filas.length;
  };

  const tipoActualLabel = TIPOS.find(t => t.id === tipo)?.label ?? "";

  return (
    <div style={{ maxWidth: 1140, margin: "0 auto", padding: "32px 24px" }}>

      {/* ── Header + Selector de Tipo ── */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        flexWrap: "wrap", gap: 16, marginBottom: 24,
      }}>
        {/* Título + tabs al lado */}
        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 20 }}>
          <div>
            <h1 style={{ fontSize: 26, fontWeight: 800, color: "var(--navy)", letterSpacing: "-0.5px", whiteSpace: "nowrap" }}>
              Clientes por Monto Total
            </h1>
            <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 3 }}>
              Ranking de clientes según ventas acumuladas
            </p>
          </div>

          {/* Separador vertical */}
          <div style={{ width: 1, height: 40, backgroundColor: "var(--border-color)", flexShrink: 0 }} />

          {/* Tabs de tipo */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {TIPOS.map(op => {
              const activo = tipo === op.id;
              const n = conteo(op.id);
              return (
                <button
                  key={op.id}
                  onClick={() => handleTipoChange(op.id)}
                  title={op.desc}
                  style={{
                    padding: "6px 14px", borderRadius: 8, fontSize: 13, fontWeight: 600,
                    cursor: "pointer", transition: "all 0.15s",
                    backgroundColor: activo ? "#E8600A" : "var(--bg-card)",
                    color: activo ? "#fff" : "var(--text-secondary)",
                    border: activo ? "2px solid #E8600A" : "2px solid var(--border-color)",
                  }}
                >
                  {op.label}
                  {secciones.length > 0 && (
                    <span style={{
                      marginLeft: 5, fontSize: 11, fontWeight: 700,
                      backgroundColor: activo ? "rgba(255,255,255,0.25)" : "var(--bg-secondary)",
                      color: activo ? "#fff" : "var(--text-muted)",
                      borderRadius: 20, padding: "1px 6px",
                    }}>
                      {n}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Chips de secciones detectadas */}
          {secciones.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Detectadas:</span>
              {secciones.map((s, i) => (
                <span key={i} style={{
                  fontSize: 11, padding: "2px 9px", borderRadius: 20, fontWeight: 600,
                  backgroundColor: s.tipo === "notas" ? "rgba(99,102,241,0.1)"
                    : s.tipo === "facturas" ? "rgba(16,185,129,0.1)"
                    : s.tipo === "descuentos" ? "rgba(239,68,68,0.1)"
                    : "rgba(148,163,184,0.1)",
                  color: s.tipo === "notas" ? "#6366F1"
                    : s.tipo === "facturas" ? "#10B981"
                    : s.tipo === "descuentos" ? "#EF4444"
                    : "var(--text-muted)",
                }}>
                  {s.label} ({s.filas.length})
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Botón descargar */}
        <button
          onClick={downloadReport}
          disabled={!clients.length}
          style={{
            display: "flex", alignItems: "center", gap: 8, flexShrink: 0,
            backgroundColor: clients.length ? "#E8600A" : "#ccc",
            color: "#fff", border: "none", borderRadius: 8,
            padding: "10px 20px", fontWeight: 700, fontSize: 14,
            cursor: clients.length ? "pointer" : "not-allowed",
          }}
          onMouseEnter={e => { if (clients.length) (e.currentTarget as HTMLButtonElement).style.backgroundColor = "#C44E06"; }}
          onMouseLeave={e => { if (clients.length) (e.currentTarget as HTMLButtonElement).style.backgroundColor = "#E8600A"; }}
        >
          <Download size={15} /> Descargar Reporte
        </button>
      </div>

      {/* ── Upload + Filtro ── */}
      <div style={{
        backgroundColor: "var(--bg-card)", border: "1px solid var(--border-color)",
        borderRadius: 12, padding: "20px 24px", marginBottom: 24,
        display: "flex", flexWrap: "wrap", gap: 28,
      }}>
        {/* Drop zone */}
        <div
          onClick={() => inputRef.current?.click()}
          onDragOver={e => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          style={{
            width: 250, minHeight: 130, borderRadius: 12, cursor: "pointer",
            border: `2px dashed ${dragging ? "#E8600A" : fileName ? "#10B981" : "var(--border-color)"}`,
            backgroundColor: dragging ? "rgba(232,96,10,0.05)" : "var(--bg-secondary)",
            display: "flex", flexDirection: "column", alignItems: "center",
            justifyContent: "center", gap: 10, padding: "16px 12px",
            transition: "border-color 0.2s",
          }}
        >
          <input ref={inputRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: "none" }} onChange={handleFileChange} />

          {loading ? (
            <>
              <RefreshCw size={28} color="#E8600A" style={{ animation: "spin 1s linear infinite" }} />
              <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>Procesando…</p>
            </>
          ) : fileName ? (
            <>
              <div style={{ width: 44, height: 44, borderRadius: "50%", backgroundColor: "rgba(16,185,129,0.1)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Users size={22} color="#10B981" />
              </div>
              <p style={{ fontSize: 12, color: "var(--text-primary)", textAlign: "center", wordBreak: "break-all", maxWidth: 210 }}>{fileName}</p>
              <button
                onClick={e => { e.stopPropagation(); reset(); }}
                style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--text-muted)", border: "1px solid var(--border-color)", borderRadius: 6, padding: "3px 10px", backgroundColor: "transparent", cursor: "pointer" }}
              >
                <X size={11} /> Limpiar
              </button>
            </>
          ) : (
            <>
              <div style={{ width: 52, height: 52, borderRadius: "50%", backgroundColor: "rgba(232,96,10,0.1)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Upload size={24} color="#E8600A" />
              </div>
              <div style={{ textAlign: "center" }}>
                <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>Arrastra tu archivo Excel aquí</p>
                <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>Formatos soportados: .xlsx, .xls, .csv</p>
                <p style={{ fontSize: 12, fontWeight: 700, color: "#E8600A", marginTop: 8, backgroundColor: "rgba(232,96,10,0.08)", borderRadius: 6, padding: "4px 10px", display: "inline-block" }}>
                  📄 Usar Informe de Facturas #6
                </p>
              </div>
              <button
                onClick={e => { e.stopPropagation(); inputRef.current?.click(); }}
                style={{ backgroundColor: "#E8600A", color: "#fff", border: "none", borderRadius: 7, padding: "6px 16px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}
              >
                Seleccionar Archivo
              </button>
            </>
          )}
        </div>

        {/* Filtro */}
        <div style={{ flex: 1, minWidth: 260, display: "flex", flexDirection: "column", justifyContent: "center", gap: 16 }}>

          {/* Buscador por nombre */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-secondary)" }}>
              Buscar cliente:
            </label>
            <input
              type="text"
              placeholder="Escribe el nombre del cliente..."
              value={busqueda}
              onChange={e => setBusqueda(e.target.value)}
              style={{ padding: "8px 12px", borderRadius: 8, fontSize: 13, border: "1px solid var(--border-color)", backgroundColor: "var(--bg-secondary)", color: "var(--text-primary)", outline: "none", width: "100%", maxWidth: 360 }}
            />
          </div>

          <p style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-secondary)" }}>
            Filtrar por Monto Total:
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
            {[
              { label: "Mínimo $", val: filterMin, set: setFilterMin, ph: "0.00", w: 130 },
              { label: "Máximo $", val: filterMax, set: setFilterMax, ph: "9,999,999.00", w: 160 },
            ].map(({ label, val, set, ph, w }) => (
              <div key={label} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <label style={{ fontSize: 11, color: "var(--text-muted)" }}>{label}</label>
                <input
                  type="number" placeholder={ph} value={val}
                  onChange={e => set(e.target.value)}
                  style={{ width: w, padding: "8px 12px", borderRadius: 8, fontSize: 13, border: "1px solid var(--border-color)", backgroundColor: "var(--bg-secondary)", color: "var(--text-primary)", outline: "none" }}
                />
              </div>
            ))}
            <button
              onClick={applyFilter}
              disabled={!allClients.length}
              style={{ padding: "8px 16px", border: "2px solid #E8600A", borderRadius: 8, color: "#E8600A", backgroundColor: "transparent", fontSize: 13, fontWeight: 700, cursor: allClients.length ? "pointer" : "not-allowed", opacity: allClients.length ? 1 : 0.4 }}
            >
              Aplicar Filtro
            </button>
            {(filterMin || filterMax || busqueda) && (
              <button onClick={clearFilter} style={{ fontSize: 13, color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }}>
                Limpiar
              </button>
            )}

            {/* Total general */}
            {clientesFiltrados.length > 0 && (
              <div style={{ marginLeft: "auto", textAlign: "right", backgroundColor: "rgba(232,96,10,0.06)", border: "1px solid rgba(232,96,10,0.2)", borderRadius: 10, padding: "8px 16px" }}>
                <p style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 2 }}>TOTAL GENERAL</p>
                <p style={{ fontSize: 18, fontWeight: 800, color: "#E8600A" }}>{fmtMoney(totalGeneral)}</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Error ── */}
      {error && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderRadius: 8, backgroundColor: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", color: "#EF4444", fontSize: 13, marginBottom: 20 }}>
          <AlertTriangle size={16} /> {error}
        </div>
      )}

      {/* ── Tabla ── */}
      <div style={{ borderRadius: 12, overflow: "hidden", border: "1px solid var(--border-color)" }}>
        <div style={{ backgroundColor: "var(--navy)", padding: "14px 20px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <p style={{ color: "#fff", fontWeight: 700, fontSize: 14 }}>
            Escalafón — {tipoActualLabel}
          </p>
          {updatedAt && (
            <p style={{ color: "rgba(255,255,255,0.5)", fontSize: 11, letterSpacing: "0.05em" }}>
              ACTUALIZADO: HOY {updatedAt}
            </p>
          )}
        </div>

        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ backgroundColor: "var(--bg-card)", borderBottom: "1px solid var(--border-color)" }}>
              {["#", "CLIENTE", "TOTAL VENDIDO", "# DE COMPRAS"].map(h => (
                <th key={h} style={{ padding: "12px 20px", textAlign: "left", fontSize: 11, fontWeight: 700, color: "var(--text-muted)", letterSpacing: "0.08em" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={4} style={{ textAlign: "center", padding: 60, backgroundColor: "var(--bg-card)" }}>
                <RefreshCw size={24} color="#E8600A" style={{ animation: "spin 1s linear infinite" }} />
              </td></tr>
            )}

            {!loading && clientesFiltrados.length === 0 && (
              <tr><td colSpan={4} style={{ textAlign: "center", padding: 60, fontSize: 13, color: "var(--text-muted)", backgroundColor: "var(--bg-card)" }}>
                {secciones.length === 0
                  ? "Carga un archivo Excel para ver el ranking de clientes."
                  : busqueda
                  ? `No se encontró ningún cliente con "${busqueda}".`
                  : `No hay datos de tipo "${tipoActualLabel}" en este archivo.`}
              </td></tr>
            )}

            {!loading && clientesFiltrados.map((c, idx) => (
              <tr
                key={c.cliente}
                style={{ backgroundColor: "var(--bg-card)", borderBottom: "1px solid var(--border-color)", transition: "background 0.12s" }}
                onMouseEnter={e => (e.currentTarget as HTMLTableRowElement).style.backgroundColor = "var(--bg-secondary)"}
                onMouseLeave={e => (e.currentTarget as HTMLTableRowElement).style.backgroundColor = "var(--bg-card)"}
              >
                <td style={{ padding: "14px 20px", width: 60 }}><RankBadge rank={idx + 1} /></td>
                <td style={{ padding: "14px 20px", fontSize: 14, fontWeight: 500, color: "var(--text-primary)" }}>{c.cliente}</td>
                <td style={{ padding: "14px 20px", fontSize: 14, fontWeight: 700, color: "#E8600A" }}>{fmtMoney(c.total)}</td>
                <td style={{ padding: "14px 20px", fontSize: 13, color: "var(--text-secondary)" }}>{c.compras} {c.compras === 1 ? "compra" : "compras"}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {clientesFiltrados.length > 0 && (
          <div style={{ padding: "10px 20px", borderTop: "1px solid var(--border-color)", backgroundColor: "var(--bg-card)", textAlign: "right" }}>
            <p style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
              Mostrando {clientesFiltrados.length} de {allClients.length} clientes
            </p>
          </div>
        )}
      </div>

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
