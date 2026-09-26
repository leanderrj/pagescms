"use client";

import { useState } from "react";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Button } from "@/components/ui/button";
import { Loader, RefreshCw } from "lucide-react";

/**
 * Shown when a server component can't reach GitHub due to a transient failure
 * (5xx, rate limit, network blip). Lets the user retry without losing context,
 * instead of the generic "Something went wrong" crash boundary.
 */
const GithubUnavailable = ({ rateLimited = false }: { rateLimited?: boolean }) => {
  const [loading, setLoading] = useState(false);

  const handleRetry = () => {
    if (loading) return;
    setLoading(true);
    window.location.reload();
  };

  return (
    <Empty className="absolute inset-0 border-0 rounded-none">
      <EmptyHeader>
        <EmptyTitle>GitHub is temporarily unavailable</EmptyTitle>
        <EmptyDescription>
          {rateLimited
            ? "GitHub rate limited this request. Wait a moment and try again."
            : "We couldn't reach GitHub just now. This is usually temporary — try again in a moment."}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="default" onClick={handleRetry} disabled={loading}>
          {loading ? <Loader className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          Try again
        </Button>
      </EmptyContent>
    </Empty>
  );
};

export { GithubUnavailable };
