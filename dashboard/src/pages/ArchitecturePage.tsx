export const ArchitecturePage = () => (
  <iframe
    src={`${import.meta.env.BASE_URL}architecture.html`}
    title="Architecture"
    style={{
      display: 'block',
      border: 'none',
      /* cancel .main's padding so the iframe bleeds to the edges */
      width: 'calc(100% + 72px)',
      height: 'calc(100vh - 88px)',
      margin: '-28px -36px',
    }}
  />
);
