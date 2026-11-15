// A fresh user gesture always retries a failed/stopped scene and resumes a suspended context.
// The ambient layer starts separately so a failed clip download cannot silence the garden.
export function createAudioPlayback({ getAudio, ambience, onStarted = () => {}, onError = (error) => console.warn('[audio]', error.message) }) {
  let pending = null;
  const report = (error) => { onError(error); return false; };
  return {
    start() {
      try { Promise.resolve(ambience?.start()).catch(report); } catch (error) { report(error); }
      const audio = getAudio();
      if (audio?.status !== 'ready') return Promise.resolve(false);
      try {
        // Resume synchronously even when the scene's voices were already started on an earlier entry.
        const context = audio.engine?.audioContext;
        if (context && context.state !== 'running') Promise.resolve(context.resume()).catch(report);
        if (audio.engine?.isPlaying) { onStarted(); return Promise.resolve(true); }
        if (pending?.audio === audio) return pending.promise;
        const result = audio.start(); // before any await: preserve transient user activation
        const request = { audio, promise: null };
        request.promise = Promise.resolve(result).then(() => { onStarted(); return true; }).catch(report).finally(() => { if (pending === request) pending = null; });
        pending = request;
        return request.promise;
      } catch (error) { return Promise.resolve(report(error)); }
    },
  };
}
