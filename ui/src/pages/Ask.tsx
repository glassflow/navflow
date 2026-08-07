import AskChat from "../components/AskChat";

// One assistant, one door. There used to be a second tab, "Organize", with its own start gate and
// its own 200-line chat — but it POSTed the same tools to the same endpoint and differed only by a
// system prompt. That prompt's judgement now applies to every proposal (tares/agent.py), and its
// full-source sweep is a starter prompt here, so the split bought nothing but a choice to make.
export default function Ask() {
  return (
    <>
      <h1>Ask</h1>
      <AskChat />
    </>
  );
}
