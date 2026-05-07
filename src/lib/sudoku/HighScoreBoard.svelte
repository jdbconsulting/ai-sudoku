<script lang="ts">
	import { HIGH_SCORES, type HighScore } from './highscores';
	import {
		apiEnabled,
		fetchScoreById,
		fetchTopScores,
		LeaderboardError,
		type FullScore,
		type LeaderboardEntry
	} from './leaderboard';

	type Props = {
		// Parent owns tab state, so opening a new puzzle from the leaderboard
		// is just a callback. The parent wires each callback to "create a
		// new tab and apply the boards". Famous Algorithms get the synchronous
		// path (boards are baked into the static entry); user-submitted
		// entries get the async path because we have to fetch the boards
		// from the API first.
		onPlay: (entry: HighScore) => void;
		onPlayUserScore: (entry: FullScore) => void;
	};
	let { onPlay, onPlayUserScore }: Props = $props();

	const fmtScore = new Intl.NumberFormat('en-US');
	function formatScore(s: number): string {
		return Number.isFinite(s) ? fmtScore.format(s) : '—';
	}

	// Author display gets a small accent color so the two famous "players"
	// are visually distinct. Strassen = blue (theory), AlphaTensor = green (AI).
	function authorClass(author: string): string {
		if (author === 'Strassen') return 'a-strassen';
		if (author === 'AlphaTensor') return 'a-alphatensor';
		return '';
	}

	// === Live leaderboard ===================================================

	let entries = $state<LeaderboardEntry[]>([]);
	let loading = $state(false);
	let error = $state<string | null>(null);

	async function loadLeaderboard() {
		if (!apiEnabled) return;
		loading = true;
		error = null;
		try {
			entries = await fetchTopScores();
		} catch (err) {
			if (err instanceof LeaderboardError) error = err.message;
			else error = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		// Run once when the tab mounts. Parent re-mounts the component on
		// tab switches via {#key activeTab.id}, so each visit gets a fresh
		// fetch — fine for a low-traffic public board.
		loadLeaderboard();
	});

	const fmtDate = new Intl.DateTimeFormat(undefined, {
		year: 'numeric',
		month: 'short',
		day: 'numeric'
	});
	function formatDate(iso: string): string {
		const d = new Date(iso);
		return Number.isFinite(d.getTime()) ? fmtDate.format(d) : iso;
	}

	// Per-row "Play" loading state. We track by id so multiple rows can
	// be in-flight simultaneously without their busy spinners colliding,
	// though in practice the user clicks one at a time.
	let playingId = $state<string | null>(null);
	let playError = $state<string | null>(null);

	async function playEntry(entry: LeaderboardEntry) {
		if (playingId) return;
		playingId = entry.id;
		playError = null;
		try {
			const full = await fetchScoreById(entry.id);
			onPlayUserScore(full);
		} catch (err) {
			playError =
				err instanceof LeaderboardError
					? err.message
					: err instanceof Error
						? err.message
						: String(err);
		} finally {
			playingId = null;
		}
	}
</script>

<!-- =====================================================================
     Live high score board — top 100 player submissions
     ===================================================================== -->
<section class="board card">
	<header class="header">
		<div class="header-row">
			<h2>High Score Board</h2>
			{#if apiEnabled}
				<button
					type="button"
					class="refresh"
					onclick={loadLeaderboard}
					disabled={loading}
					title="Reload the leaderboard"
				>
					{loading ? 'Refreshing…' : 'Refresh'}
				</button>
			{/if}
		</div>
		<p class="hint">
			The top 100 player submissions, ranked by score. Solve a puzzle in any game tab and use <strong
				>Submit score…</strong
			>
			to add your result. Scores are recomputed server-side on submission, so whatever ranks here is provably
			valid for the chosen
			<code>⟨m,n,p⟩</code>.
		</p>
	</header>

	{#if !apiEnabled}
		<div class="empty">
			<p>
				This build was compiled without a leaderboard backend (<code>PUBLIC_API_URL</code> is unset),
				so player submissions are disabled. The Famous Algorithms board below still works.
			</p>
		</div>
	{:else if error}
		<div class="empty error">
			<p>Couldn't load the leaderboard: <strong>{error}</strong></p>
			<button type="button" onclick={loadLeaderboard}>Try again</button>
		</div>
	{:else if loading && entries.length === 0}
		<div class="empty">
			<p>Loading top scores…</p>
		</div>
	{:else if entries.length === 0}
		<div class="empty">
			<p>
				No scores yet — be the first! Open a game tab, solve any puzzle, then click <strong
					>Submit score…</strong
				> to claim the top spot.
			</p>
		</div>
	{:else}
		<div class="table-scroll">
			<table>
				<thead>
					<tr>
						<th class="rank-col">#</th>
						<th class="player">Player</th>
						<th class="date">When</th>
						<th class="dims">⟨m,n,p⟩</th>
						<th class="reff" title="Effective rank: ranks used + L1 patch cost for the residual.">
							R<sub>eff</sub>
						</th>
						<th
							class="omega"
							title="Effective asymptotic exponent (lower is better, 2 = ideal, 3 = naive)."
						>
							ω
						</th>
						<th class="score">Score</th>
						<th class="solved" title="The submitted boards drove the residual to zero.">✓</th>
						<th class="actions"></th>
					</tr>
				</thead>
				<tbody>
					{#each entries as e, i (e.id)}
						<tr class:top={i === 0}>
							<td class="rank-col">{i + 1}</td>
							<td class="player">
								<span class="username">{e.username}</span>
							</td>
							<td class="date">{formatDate(e.submittedAt)}</td>
							<td class="dims">⟨{e.m},{e.n},{e.p}⟩</td>
							<td class="reff">{e.Reff}</td>
							<td class="omega">{e.omega.toFixed(3)}</td>
							<td class="score">{formatScore(e.score)}</td>
							<td class="solved">{e.solved ? '★' : ''}</td>
							<td class="actions">
								<button
									type="button"
									class="play"
									disabled={playingId !== null}
									onclick={() => playEntry(e)}
									title={`Open ${e.username}'s ⟨${e.m},${e.n},${e.p}⟩ submission in a new puzzle tab`}
								>
									{playingId === e.id ? '…' : 'Play →'}
								</button>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		{#if playError}
			<p class="row-error" role="status" aria-live="polite">
				Couldn't open replay: <strong>{playError}</strong>
			</p>
		{/if}
	{/if}
</section>

<!-- =====================================================================
     Static "Famous Algorithms" — Strassen + AlphaTensor presets
     ===================================================================== -->
<section class="board card famous">
	<header class="header">
		<h2>Famous Algorithms</h2>
		<p class="hint">
			Famous and best-known matrix-multiplication algorithms whose factor entries already live in <code
				>{`{−1, 0, +1}`}</code
			>
			— the alphabet this game lets you play with — scored using the same ω-based formula as the live
			puzzles. Click <strong>Play</strong> on any row to spawn a new tab with that algorithm pre-loaded
			into the boards, ready for you to study, perturb, or try to improve on.
		</p>
	</header>

	<div class="table-scroll">
		<table>
			<thead>
				<tr>
					<th class="player">Author</th>
					<th class="year">Year</th>
					<th class="dims">⟨m,n,p⟩</th>
					<th class="rank" title="Rank — number of multiplications">R</th>
					<th class="naive" title="Schoolbook bound m·n·p">m·n·p</th>
					<th
						class="omega"
						title="Effective asymptotic exponent: max(3·log(R)/log(m·n·p), 2 + log(depth+1)/log(N_ref)) at N_ref = 2²⁰. The second term is the divide-and-conquer polylog floor."
					>
						ω
					</th>
					<th class="score">Score</th>
					<th class="actions"></th>
				</tr>
			</thead>
			<tbody>
				{#each HIGH_SCORES as entry, i (entry.author + ':' + entry.m + ',' + entry.n + ',' + entry.p)}
					<tr class:top={i === 0}>
						<td class="player">
							<a
								class="author {authorClass(entry.author)}"
								href={entry.sourceUrl}
								target="_blank"
								rel="noopener noreferrer"
								title={`Open the ${entry.author} reference in a new tab`}
							>
								{entry.author}
							</a>
						</td>
						<td class="year">{entry.year}</td>
						<td class="dims">⟨{entry.m},{entry.n},{entry.p}⟩</td>
						<td class="rank">{entry.R}</td>
						<td class="naive">{entry.m * entry.n * entry.p}</td>
						<td class="omega">{entry.omega.toFixed(3)}</td>
						<td class="score">{formatScore(entry.score)}</td>
						<td class="actions">
							<button
								type="button"
								class="play"
								onclick={() => onPlay(entry)}
								title={`Open ⟨${entry.m},${entry.n},${entry.p}⟩ R=${entry.R} (${entry.author}, ${entry.year}) in a new puzzle tab`}
							>
								Play →
							</button>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>

	<footer class="footnote">
		<p>
			AlphaTensor entries are extracted from
			<a href="https://github.com/deepmind/alphatensor" target="_blank" rel="noopener noreferrer"
				>DeepMind's official release</a
			>
			(<code>factorizations_r.npz</code>, Apache-2.0). Only factorizations whose entries already
			live in <code>{`{−1, 0, +1}`}</code> can be represented on the player's grid, so larger results
			from the paper that need ±2 or fractional factors are omitted here.
		</p>
	</footer>
</section>

<style>
	.card {
		background: oklch(0.16 0.02 240 / 0.7);
		border: 1px solid rgb(30 41 59);
		border-radius: 14px;
		padding: 1.25rem 1.5rem 1rem;
		backdrop-filter: blur(6px);
	}
	.famous {
		margin-top: 1.25rem;
	}

	.header {
		margin-bottom: 0.85rem;
	}
	.header-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.75rem;
		margin-bottom: 0.35rem;
	}
	.header h2 {
		margin: 0 0 0.35rem;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-weight: 800;
		letter-spacing: 0.06em;
		font-size: clamp(1.1rem, 2vw, 1.45rem);
		color: rgb(248 250 252);
	}
	.header-row h2 {
		margin: 0;
	}
	.refresh {
		all: unset;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		padding: 0.35rem 0.7rem;
		border-radius: 6px;
		color: rgb(148 163 184);
		background: oklch(0.22 0.03 240 / 0.6);
		border: 1px solid rgb(51 65 85);
		cursor: pointer;
	}
	.refresh:hover:not(:disabled) {
		background: oklch(0.28 0.04 240 / 0.8);
		color: rgb(226 232 240);
	}
	.refresh:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.hint {
		margin: 0;
		font-size: 0.85rem;
		color: rgb(148 163 184);
		max-width: 78ch;
	}
	.hint code {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		background: rgb(30 41 59);
		padding: 0 0.3em;
		border-radius: 4px;
		color: rgb(125 211 252);
	}
	.hint strong {
		color: rgb(226 232 240);
	}

	.empty {
		padding: 1.5rem 1rem;
		text-align: center;
		color: rgb(148 163 184);
		font-size: 0.9rem;
		border: 1px dashed rgb(51 65 85);
		border-radius: 10px;
	}
	.empty.error {
		border-color: oklch(0.55 0.18 25 / 0.5);
		background: oklch(0.32 0.1 25 / 0.15);
		color: rgb(252 165 165);
	}
	.row-error {
		margin: 0.6rem 0 0;
		padding: 0.55rem 0.8rem;
		border-radius: 8px;
		border: 1px solid oklch(0.55 0.18 25 / 0.5);
		background: oklch(0.32 0.1 25 / 0.15);
		color: rgb(252 165 165);
		font-size: 0.8rem;
	}
	.row-error strong {
		color: rgb(254 215 215);
	}
	.empty strong {
		color: rgb(248 250 252);
	}
	.empty button {
		margin-top: 0.6rem;
		padding: 0.35rem 0.75rem;
		background: rgb(30 41 59);
		color: rgb(226 232 240);
		border: 1px solid rgb(51 65 85);
		border-radius: 6px;
		cursor: pointer;
		font-family: inherit;
		font-size: 0.78rem;
	}
	.empty button:hover {
		background: rgb(51 65 85);
	}

	.table-scroll {
		overflow-x: auto;
		scrollbar-width: thin;
	}
	table {
		width: 100%;
		border-collapse: separate;
		border-spacing: 0;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.85rem;
		min-width: 640px;
	}
	thead th {
		text-align: left;
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: rgb(148 163 184);
		font-weight: 600;
		padding: 0.5rem 0.75rem;
		border-bottom: 1px solid rgb(30 41 59);
		white-space: nowrap;
		background: oklch(0.13 0.02 240 / 0.55);
		position: sticky;
		top: 0;
	}
	tbody td {
		padding: 0.55rem 0.75rem;
		border-bottom: 1px solid rgb(30 41 59);
		color: rgb(226 232 240);
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
	}
	tbody tr:last-child td {
		border-bottom: none;
	}
	tbody tr:hover td {
		background: oklch(0.22 0.03 240 / 0.4);
	}

	tbody tr.top td.score {
		color: oklch(0.85 0.18 50);
		font-weight: 700;
	}

	.dims,
	.rank,
	.reff,
	.naive,
	.omega,
	.score,
	.rank-col,
	.solved {
		text-align: right;
	}
	.player {
		min-width: 9em;
	}
	.actions {
		text-align: right;
		width: 1%;
	}

	.rank-col {
		color: rgb(100 116 139);
		font-weight: 700;
		width: 3em;
	}
	.username {
		font-weight: 700;
		color: rgb(226 232 240);
		max-width: 14em;
		overflow: hidden;
		text-overflow: ellipsis;
		display: inline-block;
		vertical-align: bottom;
	}
	.date {
		color: rgb(148 163 184);
		font-size: 0.78rem;
	}
	.solved {
		color: oklch(0.85 0.2 145);
		font-weight: 700;
		width: 2em;
	}
	.reff {
		color: rgb(203 213 225);
		font-weight: 600;
	}

	.author {
		text-decoration: none;
		font-weight: 700;
		color: rgb(226 232 240);
		border-bottom: 1px dotted oklch(0.5 0.04 240);
		padding-bottom: 1px;
	}
	.author:hover {
		color: rgb(248 250 252);
		border-bottom-color: rgb(125 211 252);
	}
	.author.a-strassen {
		color: oklch(0.82 0.15 230);
	}
	.author.a-alphatensor {
		color: oklch(0.82 0.18 145);
	}

	.naive {
		color: rgb(100 116 139);
	}
	.omega {
		color: rgb(125 211 252);
	}
	.rank {
		font-weight: 600;
	}
	.score {
		color: rgb(226 232 240);
		font-weight: 600;
	}

	.play {
		background: linear-gradient(135deg, oklch(0.62 0.18 230), oklch(0.55 0.18 260));
		color: rgb(15 23 42);
		border: 1px solid transparent;
		padding: 0.35rem 0.75rem;
		border-radius: 6px;
		font-family: inherit;
		font-size: 0.78rem;
		font-weight: 700;
		letter-spacing: 0.04em;
		cursor: pointer;
		transition:
			filter 120ms ease,
			transform 120ms ease;
	}
	.play:hover {
		filter: brightness(1.15);
	}
	.play:active {
		transform: translateY(1px);
	}
	.play:focus-visible {
		outline: 2px solid oklch(0.85 0.18 145);
		outline-offset: 2px;
	}

	.footnote {
		margin-top: 0.85rem;
		padding-top: 0.6rem;
		border-top: 1px solid rgb(30 41 59);
	}
	.footnote p {
		margin: 0;
		font-size: 0.72rem;
		color: rgb(100 116 139);
		max-width: 78ch;
	}
	.footnote a {
		color: rgb(148 163 184);
		text-decoration: underline dotted;
	}
	.footnote a:hover {
		color: rgb(203 213 225);
	}
	.footnote code {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		background: rgb(30 41 59);
		padding: 0 0.3em;
		border-radius: 4px;
		color: rgb(125 211 252);
	}
</style>
