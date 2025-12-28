import CompareMaps from "./components/CompareMaps";

export default function Home() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 font-sans ">
      <main className="flex min-h-screen w-full flex-col gap-10 py-12 px-6 bg-white sm:px-16">
        <div className="w-full max-w-6xl mx-auto">
          <CompareMaps />
        </div>
      </main>
    </div>
  );
}
