import { useMemo, useRef, useState } from 'react';
import { withOccurrences } from '../../shared/dedupe';
import { parseCsv } from '../../shared/import/csv';
import { parseOfx, type OfxStatement } from '../../shared/import/ofx';
import { applyMapping, detectPreset, findHeaderRow, type ColumnMapping } from '../../shared/import/presets';
import { api, del, errorMessage, post, put } from '../api';
import { plural, shortDate, timeAgo } from '../format';
import { go } from '../router';
import { useApp, useLoad } from '../state';
import { Button, Card, Field, Money, Segmented, Toggle } from '../ui';
import { SubHeader } from './More';

interface Batch {
  id: number;
  accountName: string;
  filename: string | null;
  format: 'csv' | 'ofx';
  rowCount: number;
  insertedCount: number;
  duplicateCount: number;
  createdAt: string;
  createdBy: string | null;
}

interface SavedMapping {
  headerSignature: string;
  name: string;
  accountId: number | null;
  mapping: ColumnMapping;
}

interface FinishResult {
  insertedCount: number;
  duplicateCount: number;
  transfers: number;
  uncategorized: number;
}

type Stage = 'pick' | 'map' | 'running' | 'done';

export function Import() {
  const { accounts, toast, reload } = useApp();
  const batches = useLoad(() => api<Batch[]>('/import/batches'), []);
  const fileInput = useRef<HTMLInputElement>(null);

  const [stage, setStage] = useState<Stage>('pick');
  const [fileName, setFileName] = useState('');
  const [csvRows, setCsvRows] = useState<string[][] | null>(null);
  const [statements, setStatements] = useState<OfxStatement[] | null>(null);
  const [statementIndex, setStatementIndex] = useState(0);
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  const [presetLabel, setPresetLabel] = useState<string | null>(null);
  const [accountId, setAccountId] = useState<number | null>(null);
  const [newAccountName, setNewAccountName] = useState('');
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [result, setResult] = useState<(FinishResult & { batchId: number }) | null>(null);

  function reset() {
    setStage('pick');
    setCsvRows(null);
    setStatements(null);
    setMapping(null);
    setResult(null);
    setAccountId(null);
    setNewAccountName('');
    if (fileInput.current) fileInput.current.value = '';
  }

  async function onFile(file: File) {
    const text = await file.text();
    setFileName(file.name);
    if (/\.(ofx|qfx|qbo)$/i.test(file.name) || /<OFX>/i.test(text)) {
      const parsed = parseOfx(text).filter((s) => s.transactions.length);
      if (!parsed.length) {
        toast('No transactions found in that file', 'error');
        return;
      }
      setStatements(parsed);
      setCsvRows(null);
      setStatementIndex(0);
      const mask = parsed[0]?.mask;
      setAccountId(accounts.find((a) => mask && a.mask === mask)?.id ?? null);
    } else {
      const rows = parseCsv(text);
      if (rows.length < 2) {
        toast('That file looks empty', 'error');
        return;
      }
      setCsvRows(rows);
      setStatements(null);
      const detected = detectPreset(rows);
      const headerRow = detected?.mapping.headerRow ?? findHeaderRow(rows);
      const signature = (rows[headerRow] ?? []).join('|');
      const saved = await api<SavedMapping[]>('/import/mappings')
        .then((list) => list.find((m) => m.headerSignature === signature))
        .catch(() => undefined);
      if (saved) {
        setMapping(saved.mapping);
        setPresetLabel(`${saved.name} (saved)`);
        setAccountId(saved.accountId);
      } else if (detected) {
        setMapping(detected.mapping);
        setPresetLabel(detected.preset.label);
      } else {
        setMapping({ headerRow, date: 0, description: 1, amount: 2 });
        setPresetLabel(null);
      }
    }
    setStage('map');
  }

  const parsed = useMemo(() => {
    if (statements) {
      const statement = statements[statementIndex];
      return {
        rows: (statement?.transactions ?? []).map((t) => ({ date: t.date, name: t.name, amountCents: t.amountCents, memo: t.memo, fitId: t.fitId })),
        skipped: [] as { line: number; reason: string }[],
      };
    }
    if (csvRows && mapping) return applyMapping(csvRows, mapping);
    return { rows: [], skipped: [] };
  }, [statements, statementIndex, csvRows, mapping]);

  async function runImport() {
    let target = accountId;
    try {
      if (!target) {
        if (!newAccountName.trim()) {
          toast('Pick an account or name a new one', 'error');
          return;
        }
        const statement = statements?.[statementIndex];
        const created = await post<{ id: number }>('/accounts', {
          name: newAccountName.trim(),
          type: statement?.kind === 'credit' ? 'credit' : 'checking',
          mask: statement?.mask ?? null,
        });
        target = created.id;
      }
      setStage('running');
      const format = statements ? 'ofx' : 'csv';
      const batch = await post<{ id: number }>('/import/batches', { accountId: target, filename: fileName, format });
      const rows =
        format === 'csv'
          ? withOccurrences(parsed.rows).map((r) => ({ date: r.date, name: r.name, amountCents: r.amountCents, memo: r.memo, occurrence: r.occurrence }))
          : parsed.rows;
      setProgress({ done: 0, total: rows.length });
      for (let i = 0; i < rows.length; i += 200) {
        await post(`/import/batches/${batch.id}/rows`, { rows: rows.slice(i, i + 200) });
        setProgress({ done: Math.min(rows.length, i + 200), total: rows.length });
      }
      const finish = await post<FinishResult>(`/import/batches/${batch.id}/finish`);
      if (format === 'csv' && csvRows && mapping) {
        await put('/import/mappings', {
          headerSignature: (csvRows[mapping.headerRow] ?? []).join('|'),
          name: presetLabel?.replace(' (saved)', '') ?? fileName,
          mapping,
          accountId: target,
        }).catch(() => undefined);
      }
      setResult({ ...finish, batchId: batch.id });
      setStage('done');
      await Promise.all([reload(), batches.reload()]);
    } catch (error) {
      toast(errorMessage(error), 'error');
      setStage('map');
    }
  }

  async function undo(batch: Batch) {
    if (!window.confirm(`Remove the ${plural(batch.insertedCount, 'transaction')} this import added?`)) return;
    try {
      const res = await del<{ removed: number }>(`/import/batches/${batch.id}`);
      toast(`Removed ${plural(res.removed, 'transaction')}`);
      await Promise.all([reload(), batches.reload()]);
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  const headers = csvRows && mapping ? (csvRows[mapping.headerRow] ?? []) : [];
  const amountMode = mapping && mapping.amount === undefined ? 'split' : 'single';

  function setColumn(key: 'date' | 'description' | 'amount' | 'debit' | 'credit' | 'memo', value: string) {
    if (!mapping) return;
    const next = { ...mapping };
    if (value === '') delete next[key as 'amount'];
    else next[key] = Number(value);
    setMapping(next);
  }

  function columnSelect(label: string, key: 'date' | 'description' | 'amount' | 'debit' | 'credit' | 'memo', optional = false) {
    return (
      <Field label={label}>
        <select value={mapping?.[key] ?? ''} onChange={(e) => setColumn(key, e.target.value)}>
          {optional && <option value="">None</option>}
          {headers.map((h, i) => (
            <option key={i} value={i}>
              {h || `Column ${i + 1}`}
            </option>
          ))}
        </select>
      </Field>
    );
  }

  return (
    <div className="stack">
      <SubHeader title="Import a file" subtitle="CSV, OFX or QFX downloaded from your bank's website" />

      {stage === 'pick' && (
        <>
          <Card>
            <input
              ref={fileInput}
              type="file"
              accept=".csv,.ofx,.qfx,.qbo,text/csv"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void onFile(file);
              }}
            />
            <p className="muted small">
              Re-importing the same file (or overlapping dates) is safe: duplicates are skipped automatically.
            </p>
          </Card>
          <details className="card">
            <summary>
              <strong>Where do I get the file?</strong>
            </summary>
            <div className="stack-sm small" style={{ marginTop: 8 }}>
              <p>
                <strong>Capital One:</strong> open the account, find the transactions list, and use Download. Pick CSV.
              </p>
              <p>
                <strong>Fidelity:</strong> Activity &amp; Orders (or History) for the account, then Download. The CSV works as is.
              </p>
              <p>
                <strong>Chime:</strong> Chime only offers PDF statements, so use bank sync for Chime or add cash purchases by hand.
              </p>
              <p className="muted">Menus change over time. Look for “Download”, “Export”, or a Quicken/QFX option.</p>
            </div>
          </details>
        </>
      )}

      {stage === 'map' && (
        <>
          <Card>
            <div className="spread">
              <strong>{fileName}</strong>
              <Button small variant="ghost" onClick={reset}>
                Choose another
              </Button>
            </div>
            <p className="muted small">
              {statements ? 'Quicken/OFX file' : presetLabel ? `Looks like: ${presetLabel}` : 'Unknown layout: match the columns below.'}
            </p>
          </Card>

          {statements && statements.length > 1 && (
            <Field label="This file has several accounts">
              <select value={statementIndex} onChange={(e) => setStatementIndex(Number(e.target.value))}>
                {statements.map((s, i) => (
                  <option key={i} value={i}>
                    {s.kind} ••{s.mask} ({plural(s.transactions.length, 'transaction')})
                  </option>
                ))}
              </select>
            </Field>
          )}

          {csvRows && mapping && (
            <Card>
              <div className="stack-sm">
                {columnSelect('Date', 'date')}
                {columnSelect('Description', 'description')}
                <Segmented
                  value={amountMode}
                  onChange={(mode) =>
                    setMapping(
                      mode === 'single'
                        ? { headerRow: mapping.headerRow, date: mapping.date, description: mapping.description, amount: mapping.debit ?? 0 }
                        : { headerRow: mapping.headerRow, date: mapping.date, description: mapping.description, debit: mapping.amount ?? 0, credit: mapping.amount ?? 0 },
                    )
                  }
                  options={[
                    { value: 'single', label: 'One amount column' },
                    { value: 'split', label: 'Debit & credit columns' },
                  ]}
                />
                {amountMode === 'single' ? (
                  columnSelect('Amount', 'amount')
                ) : (
                  <div className="grid-2">
                    {columnSelect('Money out (debit)', 'debit')}
                    {columnSelect('Money in (credit)', 'credit')}
                  </div>
                )}
                <Toggle
                  checked={Boolean(mapping.invertSign)}
                  onChange={(v) => setMapping({ ...mapping, invertSign: v })}
                  label="Purchases show as positive numbers"
                  hint="Turn on if spending appears green in the preview."
                />
              </div>
            </Card>
          )}

          <Card>
            <h3>Preview</h3>
            <div className="preview-table">
              <table>
                <tbody>
                  {parsed.rows.slice(0, 8).map((r, i) => (
                    <tr key={i}>
                      <td>{shortDate(r.date)}</td>
                      <td>{r.name}</td>
                      <td style={{ textAlign: 'right' }}>
                        <Money cents={r.amountCents} tone={r.amountCents > 0 ? 'good' : undefined} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted small">
              {plural(parsed.rows.length, 'transaction')} found
              {parsed.skipped.length > 0 && `, ${plural(parsed.skipped.length, 'line')} skipped`}.
            </p>
          </Card>

          <Card>
            <Field label="Import into">
              <select value={accountId ?? ''} onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : null)}>
                <option value="">New account…</option>
                {accounts
                  .filter((a) => !a.hidden)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                      {a.mask ? ` ••${a.mask}` : ''}
                    </option>
                  ))}
              </select>
            </Field>
            {!accountId && (
              <Field label="New account name">
                <input value={newAccountName} onChange={(e) => setNewAccountName(e.target.value)} placeholder="Capital One Quicksilver" />
              </Field>
            )}
          </Card>

          <Button variant="primary" onClick={() => void runImport()} disabled={!parsed.rows.length}>
            Import {plural(parsed.rows.length, 'transaction')}
          </Button>
        </>
      )}

      {stage === 'running' && (
        <Card>
          <strong>Importing…</strong>
          <p className="muted">
            {progress.done} of {progress.total}
          </p>
        </Card>
      )}

      {stage === 'done' && result && (
        <Card>
          <h2>Done</h2>
          <p>
            {plural(result.insertedCount, 'new transaction')} added
            {result.duplicateCount > 0 && `, ${plural(result.duplicateCount, 'duplicate')} skipped`}
            {result.transfers > 0 && `, ${plural(result.transfers, 'transfer')} matched`}.
          </p>
          <div className="cluster">
            {result.uncategorized > 0 && (
              <Button variant="primary" onClick={() => go('activity', { filter: 'uncategorized', batch: result.batchId })}>
                Sort {plural(result.uncategorized, 'transaction')}
              </Button>
            )}
            <Button onClick={reset}>Import another</Button>
          </div>
        </Card>
      )}

      {(batches.data?.length ?? 0) > 0 && (
        <>
          <div className="section-title">
            <h3>Recent imports</h3>
          </div>
          <div className="list">
            {batches.data?.map((b) => (
              <div key={b.id} className="row">
                <div className="row-main">
                  <div className="row-title">{b.filename ?? 'Import'}</div>
                  <div className="row-sub">
                    {b.accountName} · {plural(b.insertedCount, 'added', 'added')} · {timeAgo(b.createdAt)}
                    {b.createdBy && ` · ${b.createdBy}`}
                  </div>
                </div>
                {b.insertedCount > 0 && (
                  <Button small variant="ghost" onClick={() => void undo(b)}>
                    Undo
                  </Button>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
