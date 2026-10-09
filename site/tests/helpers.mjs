// Shared test data: small, hand-written catalog records covering every filter dimension.
export const TODAY = '2026-10-09';

export function rec(over) {
  return {
    id: 'x:1', source: 'sbir_gov', links: { official: null, sbir_gov: null, dod_dsip: null, grants_gov: null }, alt_ids: [],
    title: 'Untitled', agency: 'DOD', sub_agency: null, program: 'SBIR', phases: ['I'], topic_number: null,
    solicitation_number: null, solicitation_title: null, status: 'open', release_date: null, open_date: '2026-09-01',
    close_date: '2026-11-01', qa_open_date: null, qa_close_date: null, summary: '', keywords: [], technology_areas: [],
    year: 2026, first_seen: '2026-09-01T00:00:00Z', last_seen: '2026-10-09T06:00:00Z', last_changed: '2026-09-01T00:00:00Z',
    content_hash: '', ...over
  };
}

export const CATALOG = [
  rec({ id: 'dsip:A1', title: 'Passive acoustic detection of small UAS', agency: 'DOD', sub_agency: 'ARMY', program: 'STTR', phases: ['I'],
    topic_number: 'A26B-T014', close_date: '2026-10-12', keywords: ['acoustic', 'uas', 'counter-uas'], first_seen: '2026-10-08T06:00:00Z',
    last_changed: '2026-10-08T06:00:00Z' }),
  rec({ id: 'dsip:N2', title: 'Compact passive sonar array', agency: 'DOD', sub_agency: 'NAVY', status: 'pre_release', phases: ['I', 'II'],
    open_date: '2026-10-20', close_date: '2026-11-20', keywords: ['sonar'], first_seen: '2026-10-01' }),
  rec({ id: 'grants:3', title: 'Hearing aid audio processing', agency: 'HHS', sub_agency: 'NIH', status: 'forecasted', phases: ['I', 'II'],
    open_date: '2026-11-08', close_date: '2026-12-06', keywords: ['audio', 'hearing'], first_seen: '2026-09-15T00:00:00Z' }),
  rec({ id: 'sbirgov:4', title: 'Battery recycling for rail', agency: 'DOT', sub_agency: 'FRA', close_date: '2026-10-30', phases: ['I'],
    summary: 'Recover rare earths from batteries.', first_seen: '2026-08-01T00:00:00Z' }),
  rec({ id: 'sbirgov:5', title: 'Old closed drone topic', agency: 'DOD', sub_agency: 'USAF', status: 'closed', close_date: '2026-09-01',
    keywords: ['drone'], first_seen: '2026-07-01T00:00:00Z' }),
  rec({ id: 'grants:6', title: 'NSF robotics seed fund', agency: 'NSF', sub_agency: null, program: 'SBIR/STTR', phases: ['I'],
    close_date: null, first_seen: '2026-10-05T12:00:00Z' }),
  rec({ id: 'dsip:D7', title: 'Mission autonomy direct to phase II', agency: 'DOD', sub_agency: 'USAF', phases: ['DP2'],
    close_date: '2026-11-05', keywords: ['autonomy'], technology_areas: ['Air Platform', 'Hypersonics'], last_changed: '2026-10-09T01:00:00Z' })
];
