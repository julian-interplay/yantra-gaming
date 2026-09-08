import { useEffect, useMemo, useState } from 'react';
import { ApiError, apiRequest } from '../api/client';
import { useUIStore } from '../store/uiStore';
import Card, { ErrorBanner } from '../ui/Card';
import Money from '../ui/Money';
import PageHeader from '../ui/PageHeader';

interface PrizeRow {
  rank: number;
  amountMicro: string;
}

interface Tournament {
  id: string;
  title: string;
  status: string;
  currency: string;
  scheduledStartAt: string;
  startedAt: string | null;
  completedAt: string | null;
  minPlayers: number;
  choiceWindowMs: number;
  roundBreakMs: number;
  prizeTable: PrizeRow[];
  participantCount?: number;
  participants?: Array<{ id: string; playerRef: string; status: string; rank: number | null }>;
  matches?: Array<{ id: string; roundNumber: number; status: string; participantAId: string | null; participantBId: string | null; winnerId: string | null }>;
  prizeAwards?: Array<{ id: string; participantId: string; rank: number; amountMicro: string; status: string }>;
}

interface FormState {
  title: string;
  scheduledStartAt: string;
  minPlayers: number;
  choiceWindowMs: number;
  roundBreakMs: number;
  prizes: Array<{ rank: number; amount: string }>;
}

const MICRO_PER_HNL = 100_000n;

function hnlToMicro(value: string): string {
  const [intPart = '0', fracRaw = ''] = value.trim().split('.');
  const safeInt = intPart.replace(/[^\d]/g, '') || '0';
  const frac = `${fracRaw.replace(/[^\d]/g, '')}00000`.slice(0, 5);
  return (BigInt(safeInt) * MICRO_PER_HNL + BigInt(frac)).toString();
}

function localDateTimeValue(offsetMinutes = 30): string {
  const d = new Date(Date.now() + offsetMinutes * 60_000);
  d.setSeconds(0, 0);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

const initialForm: FormState = {
  title: 'Torneo Piedra Papel Tijera',
  scheduledStartAt: localDateTimeValue(),
  minPlayers: 2,
  choiceWindowMs: 12000,
  roundBreakMs: 3000,
  prizes: [
    { rank: 1, amount: '1000' },
    { rank: 2, amount: '250' },
    { rank: 3, amount: '100' },
  ],
};

export default function RpsTournaments() {
  const pushToast = useUIStore((s) => s.pushToast);
  const [items, setItems] = useState<Tournament[]>([]);
  const [selected, setSelected] = useState<Tournament | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<FormState>(initialForm);

  const topUpcoming = useMemo(
    () => items.filter((t) => ['SCHEDULED', 'REGISTERING', 'RUNNING'].includes(t.status)).slice(0, 3),
    [items],
  );

  async function reload() {
    setLoading(true);
    try {
      const res = await apiRequest<{ items: Tournament[] }>('/v1/admin/rps-tournaments');
      setItems(res.data.items);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(500, 'Failed to load tournaments', null));
    } finally {
      setLoading(false);
    }
  }

  async function openDetail(id: string) {
    try {
      const res = await apiRequest<{ tournament: Tournament }>(`/v1/admin/rps-tournaments/${id}`);
      setSelected(res.data.tournament);
    } catch (err) {
      pushToast('error', err instanceof ApiError ? err.message : 'Failed to load tournament');
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function createTournament() {
    try {
      await apiRequest('/v1/admin/rps-tournaments', {
        method: 'POST',
        body: {
          title: form.title,
          scheduledStartAt: new Date(form.scheduledStartAt).toISOString(),
          minPlayers: form.minPlayers,
          choiceWindowMs: form.choiceWindowMs,
          roundBreakMs: form.roundBreakMs,
          prizeTable: form.prizes
            .filter((p) => p.amount.trim().length > 0)
            .map((p) => ({ rank: p.rank, amountMicro: hnlToMicro(p.amount) })),
        },
      });
      pushToast('success', 'RPS tournament created');
      setFormOpen(false);
      setForm(initialForm);
      await reload();
    } catch (err) {
      pushToast('error', err instanceof ApiError ? err.message : 'Create failed');
    }
  }

  async function startTournament(id: string) {
    try {
      await apiRequest(`/v1/admin/rps-tournaments/${id}/start`, { method: 'POST' });
      pushToast('success', 'Tournament started');
      await reload();
      await openDetail(id);
    } catch (err) {
      pushToast('error', err instanceof ApiError ? err.message : 'Start failed');
    }
  }

  async function cancelTournament(id: string) {
    try {
      await apiRequest(`/v1/admin/rps-tournaments/${id}/cancel`, {
        method: 'POST',
        body: { reason: 'operator_cancelled' },
      });
      pushToast('success', 'Tournament cancelled');
      setSelected(null);
      await reload();
    } catch (err) {
      pushToast('error', err instanceof ApiError ? err.message : 'Cancel failed');
    }
  }

  return (
    <>
      <PageHeader
        title="RPS tournaments"
        subtitle="Free-to-play Piedra Papel Tijera events with HNL prize awards."
        actions={
          <button type="button" className="btn btn--primary" onClick={() => setFormOpen(true)}>
            New tournament
          </button>
        }
      />

      {error ? <ErrorBanner message={error.message} /> : null}

      <div className="kpi-grid">
        {topUpcoming.map((t) => (
          <Card key={t.id}>
            <div className="kpi">
              <div className="kpi__label">{t.status}</div>
              <div className="kpi__value">{t.participantCount ?? 0}</div>
              <div className="kpi__meta">{new Date(t.scheduledStartAt).toLocaleString()}</div>
            </div>
          </Card>
        ))}
      </div>

      <Card>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Status</th>
                <th>Start</th>
                <th>Players</th>
                <th>Top prize</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <tr key={t.id}>
                  <td>{t.title}</td>
                  <td><span className="chip chip--tag">{t.status}</span></td>
                  <td><code className="mono">{new Date(t.scheduledStartAt).toLocaleString()}</code></td>
                  <td>{t.participantCount ?? 0}</td>
                  <td>
                    {t.prizeTable[0] ? <Money micro={t.prizeTable[0].amountMicro} currency="HNL" /> : '—'}
                  </td>
                  <td className="row" style={{ justifyContent: 'flex-end' }}>
                    <button type="button" className="btn" onClick={() => openDetail(t.id)}>Open</button>
                    {['SCHEDULED', 'REGISTERING'].includes(t.status) ? (
                      <button type="button" className="btn btn--primary" onClick={() => startTournament(t.id)}>Start</button>
                    ) : null}
                  </td>
                </tr>
              ))}
              {items.length === 0 && !loading ? (
                <tr><td colSpan={6} className="table-empty">No RPS tournaments yet.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>

      {selected ? (
        <div className="modal-backdrop" onClick={() => setSelected(null)}>
          <div className="modal modal--wide" onClick={(e) => e.stopPropagation()}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h2>{selected.title}</h2>
              <button type="button" className="btn btn--ghost" onClick={() => setSelected(null)}>Close</button>
            </div>
            <div className="detail-grid">
              <div><dt>Status</dt><dd>{selected.status}</dd></div>
              <div><dt>Players</dt><dd>{selected.participants?.length ?? selected.participantCount ?? 0}</dd></div>
              <div><dt>Round</dt><dd>{selected.matches?.at(-1)?.roundNumber ?? '-'}</dd></div>
              <div><dt>Start</dt><dd>{new Date(selected.scheduledStartAt).toLocaleString()}</dd></div>
            </div>
            <div className="row" style={{ justifyContent: 'flex-end', margin: '12px 0' }}>
              {['SCHEDULED', 'REGISTERING'].includes(selected.status) ? (
                <button type="button" className="btn btn--primary" onClick={() => startTournament(selected.id)}>Start now</button>
              ) : null}
              {!['COMPLETED', 'CANCELLED'].includes(selected.status) ? (
                <button type="button" className="btn" onClick={() => cancelTournament(selected.id)}>Cancel</button>
              ) : null}
            </div>
            <h3>Participants</h3>
            <div className="table-wrap">
              <table className="data-table">
                <thead><tr><th>Player</th><th>Status</th><th>Rank</th></tr></thead>
                <tbody>
                  {(selected.participants ?? []).map((p) => (
                    <tr key={p.id}><td>{p.playerRef}</td><td>{p.status}</td><td>{p.rank ?? '-'}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <h3>Prize awards</h3>
            <div className="table-wrap">
              <table className="data-table">
                <thead><tr><th>Rank</th><th>Amount</th><th>Status</th></tr></thead>
                <tbody>
                  {(selected.prizeAwards ?? []).map((a) => (
                    <tr key={a.id}><td>#{a.rank}</td><td><Money micro={a.amountMicro} currency="HNL" /></td><td>{a.status}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}

      {formOpen ? (
        <div className="modal-backdrop" onClick={() => setFormOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>New RPS tournament</h2>
            <div className="stack">
              <label className="field">
                <span className="field__label">Title</span>
                <input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
              </label>
              <label className="field">
                <span className="field__label">Scheduled start</span>
                <input className="input" type="datetime-local" value={form.scheduledStartAt} onChange={(e) => setForm({ ...form, scheduledStartAt: e.target.value })} />
              </label>
              <label className="field">
                <span className="field__label">Minimum players</span>
                <input className="input" type="number" min={2} value={form.minPlayers} onChange={(e) => setForm({ ...form, minPlayers: Number(e.target.value) })} />
              </label>
              <div className="row">
                <label className="field">
                  <span className="field__label">Choice window (ms)</span>
                  <input className="input" type="number" value={form.choiceWindowMs} onChange={(e) => setForm({ ...form, choiceWindowMs: Number(e.target.value) })} />
                </label>
                <label className="field">
                  <span className="field__label">Round break (ms)</span>
                  <input className="input" type="number" value={form.roundBreakMs} onChange={(e) => setForm({ ...form, roundBreakMs: Number(e.target.value) })} />
                </label>
              </div>
              <h3>Prize table (HNL)</h3>
              {form.prizes.map((p, idx) => (
                <div className="row" key={p.rank}>
                  <input className="input" type="number" min={1} value={p.rank} onChange={(e) => {
                    const prizes = [...form.prizes];
                    prizes[idx] = { ...p, rank: Number(e.target.value) };
                    setForm({ ...form, prizes });
                  }} />
                  <input className="input" value={p.amount} onChange={(e) => {
                    const prizes = [...form.prizes];
                    prizes[idx] = { ...p, amount: e.target.value };
                    setForm({ ...form, prizes });
                  }} />
                </div>
              ))}
              <button type="button" className="btn" onClick={() => setForm({ ...form, prizes: [...form.prizes, { rank: form.prizes.length + 1, amount: '0' }] })}>
                Add prize row
              </button>
            </div>
            <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn--ghost" onClick={() => setFormOpen(false)}>Cancel</button>
              <button type="button" className="btn btn--primary" onClick={createTournament}>Create</button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
