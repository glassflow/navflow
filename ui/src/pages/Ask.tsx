import AskChat from "../components/AskChat";

// One assistant, one door. There used to be a second tab, "Organize", with its own start gate and
// its own 200-line chat — but it POSTed the same tools to the same endpoint and differed only by a
// system prompt. That prompt's judgement now applies to every proposal (tares/agent.py), and its
// full-source sweep is a starter prompt here, so the split bought nothing but a choice to make.
//
// No h1: the page is the familiar two-column AI-chat shell — conversations in a second sidebar
// flush against the nav, the active chat beside it — and the breadcrumb already names the page.
export default function Ask() {
  return <AskChat history />;
}
