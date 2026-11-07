import { Suspense } from "react";
import { GroupView } from "@/components/GroupView";

// Groups are addressed as /g/?t=<secret token> so this single static page serves every group.
export default function Page() {
  return (
    <Suspense>
      <GroupView />
    </Suspense>
  );
}
