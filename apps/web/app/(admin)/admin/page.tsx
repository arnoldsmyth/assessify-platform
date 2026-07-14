// Admin surface: Assessify-branded, session auth (03-architecture.md).
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@assessify/ui';

export default function AdminHomePage() {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold text-ink">Dashboard</h1>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Orders</CardTitle>
            <CardDescription>Recent order activity lands here.</CardDescription>
          </CardHeader>
          <CardContent className="text-2xl font-semibold text-ink">—</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Completed this week</CardTitle>
            <CardDescription>Completed assessments land here.</CardDescription>
          </CardHeader>
          <CardContent className="text-2xl font-semibold text-teal">—</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Error queue</CardTitle>
            <CardDescription>Payment, email and scoring errors land here.</CardDescription>
          </CardHeader>
          <CardContent className="text-2xl font-semibold text-red">—</CardContent>
        </Card>
      </div>
    </div>
  );
}
