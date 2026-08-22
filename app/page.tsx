export default function Home() {
  return (
    <main className="min-h-screen bg-[#0B0F14] px-6 py-8 text-zinc-100 sm:px-10">
      <div className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-6xl flex-col">
        <header className="flex items-center justify-between border-b border-white/10 pb-6">
          <div>
            <p className="text-xl font-semibold tracking-tight">HeatShift</p>
            <p className="mt-1 text-sm text-zinc-400">Plan around the heat.</p>
          </div>
          <span className="rounded-full border border-sky-400/25 bg-sky-400/10 px-3 py-1 text-xs font-medium text-sky-300">
            Phase 1 ready
          </span>
        </header>

        <section className="flex flex-1 items-center py-16">
          <div className="max-w-2xl">
            <p className="font-mono text-xs uppercase tracking-[0.22em] text-sky-400">
              Hyperlocal planning evidence
            </p>
            <h1 className="mt-5 text-4xl font-semibold tracking-[-0.04em] sm:text-6xl">
              Build the day around measured heat.
            </h1>
            <p className="mt-6 max-w-xl text-base leading-7 text-zinc-400">
              The application shell and FortyGuard server proxy are online. Site
              analysis arrives in the next phase.
            </p>
            <div className="mt-10 h-1.5 w-64 rounded-full bg-gradient-to-r from-sky-400 via-amber-400 to-red-500 shadow-[0_0_30px_rgba(56,189,248,0.18)]" />
          </div>
        </section>

        <footer className="border-t border-white/10 pt-5 text-xs text-zinc-500">
          Planning guidance, not a safety rating.
        </footer>
      </div>
    </main>
  );
}
