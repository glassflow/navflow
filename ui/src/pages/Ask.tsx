import AskChat from "../components/AskChat";

// The dedicated Ask page — for long, multi-turn sessions. The same assistant is also summonable
// from anywhere with ⌘K (see components/CommandPalette).
export default function Ask() {
  return (
    <>
      <h1>Ask</h1>
      <p className="subtitle">an assistant with read access to your NavFlow data — explore or debug what you're ingesting</p>
      <AskChat />
    </>
  );
}
