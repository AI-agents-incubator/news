export async function notify(topic, { title, message, priority = 'default', tags = '' }) {
  if (!topic) return null;

  try {
    const response = await fetch(`https://ntfy.sh/${topic}`, {
      method: 'POST',
      headers: {
        'Title': title || 'News Digest',
        'Priority': priority,
        ...(tags ? { 'Tags': tags } : {}),
      },
      body: message || '',
    });

    return response;
  } catch (err) {
    console.error('[notifier] Error sending notification:', err.message);
    return null;
  }
}

export async function notifyDigestReady(topic, digest) {
  return notify(topic, {
    title: `Digest Ready: ${digest.date || 'new'}`,
    message: `Digest with ${digest.articles_count} articles is ready for review.`,
    priority: 'default',
    tags: 'newspaper',
  });
}

export async function notifyDigestReviewReady(topic, run) {
  const itemCount = Number(run?.items_count ?? run?.items?.length ?? 0);
  const failed = run?.status === 'failed';
  const attention = run?.status === 'phase1_processing'
    || run?.status === 'phase1_attention_required';
  return notify(topic, {
    title: failed ? 'Digest Phase 1 Failed'
      : (attention ? 'Digest Phase 1 Needs Recovery' : 'Digest Phase 1 Ready'),
    message: failed
      ? `Phase 1 failed for review run ${run?.id || 'unknown'}. Open the digest dashboard for details.`
      : (attention
          ? `Review run ${run?.id || 'unknown'} is incomplete. Recover it in the digest dashboard; no automatic model retry was made.`
          : `Phase 1 completed for ${itemCount} articles. Review run ${run?.id || 'unknown'} before assembling the digest.`),
    priority: 'default',
    tags: failed || attention ? 'warning,newspaper' : 'newspaper,memo',
  });
}
