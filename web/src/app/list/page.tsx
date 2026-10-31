import { Suspense } from "react";
import { ListView } from "@/components/ListView";

// Lists are addressed as /list/?id=… so this single static page serves every list.
export default function Page() {
  return (
    <Suspense>
      <ListView />
    </Suspense>
  );
}
