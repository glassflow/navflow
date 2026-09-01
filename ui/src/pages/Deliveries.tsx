import { Dispatches } from "./Activity";

// Firings: every time a trigger fired, newest first, with who it was delivered to. One firing's
// full story (payload, per-recipient outcomes) is its own page. Subscribers live with the agents.
export default function Firings() {
  return (
    <>
      <h1>Firings</h1>
      <Dispatches />
    </>
  );
}
