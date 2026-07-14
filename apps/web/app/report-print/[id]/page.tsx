// Internal print route consumed by pdf-service (09-reports-and-pdf.md).
export default async function ReportPrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <main>
      <h1>Report print placeholder: {id}</h1>
    </main>
  );
}
