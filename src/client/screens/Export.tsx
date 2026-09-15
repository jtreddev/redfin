import { api } from '../api';
import { plural } from '../format';
import { useLoad } from '../state';
import { Card, Loading } from '../ui';
import { SubHeader } from './More';

export function Export() {
  const years = useLoad(() => api<{ year: string; n: number }[]>('/export/years'), []);
  return (
    <div className="stack">
      <SubHeader title="Export your data" subtitle="It’s your data. Take it anywhere, anytime." />
      <Card>
        <h2>Everything except transactions</h2>
        <p className="muted small">Budgets, categories, rules, goals, debts, kids, check-ins, settings (JSON).</p>
        <a className="btn btn-primary" href="/api/export/json" download>
          Download JSON
        </a>
      </Card>
      <Card>
        <h2>Transactions by year</h2>
        <p className="muted small">Opens in Excel or Google Sheets. Your partner’s private fun money purchases aren’t included in yours.</p>
        {!years.data ? (
          <Loading />
        ) : years.data.length === 0 ? (
          <p className="muted">No transactions yet.</p>
        ) : (
          <div className="cluster">
            {years.data.map((y) => (
              <a key={y.year} className="btn" href={`/api/export/transactions.csv?year=${y.year}`} download>
                {y.year} ({plural(y.n, 'row')})
              </a>
            ))}
          </div>
        )}
      </Card>
      <Card>
        <h2>Full database backup</h2>
        <p className="muted small">
          From your computer, run <code>npm run backup</code> in the project folder. It saves a complete SQL copy of the database to
          the <code>backups</code> folder. Do it weekly.
        </p>
      </Card>
    </div>
  );
}
