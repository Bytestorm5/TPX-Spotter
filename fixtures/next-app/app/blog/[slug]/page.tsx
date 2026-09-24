const POSTS: Record<string, { title: string; body: string[] }> = {
  "winter-layering-guide": {
    title: "The three-layer rule, revisited",
    body: [
      "Base, mid, shell. The rule is old because it works — but the fabrics have changed, and so has how we move in the cold.",
      "Start with merino against the skin: it handles sweat on the climb and stays warm when you stop. Over it, a light fleece or synthetic puffy you can vent.",
      "The shell's job is simple: keep wind and water out while letting vapour escape. Pit zips matter more than the spec sheet admits.",
    ],
  },
};

export function generateStaticParams() {
  return Object.keys(POSTS).map((slug) => ({ slug }));
}

export default async function Post({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = POSTS[slug] ?? { title: "Not found", body: ["This post has wandered off the trail."] };
  return (
    <article className="article">
      <p className="lede" style={{ marginBottom: 8 }}>
        Journal
      </p>
      <h1>{post.title}</h1>
      {post.body.map((p, i) => (
        <p key={i}>{p}</p>
      ))}
    </article>
  );
}
