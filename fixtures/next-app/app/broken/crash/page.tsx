import { CrashButtons } from "./crash-buttons";

export const metadata = { title: "Diagnostics — Acme Outfitters" };

export default function Crash() {
  return (
    <>
      <h1>Diagnostics</h1>
      <p className="lede">Each button breaks something on purpose, so Spotter&apos;s automatic reports have something to report.</p>
      <CrashButtons />
    </>
  );
}
