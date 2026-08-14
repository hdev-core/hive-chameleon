// Browser clipboard bridge for WebGL builds.
//
// Unity's GUIUtility.systemCopyBuffer only reaches the player's own internal
// buffer on WebGL; it never touches the browser clipboard and never reports a
// failure, so a copy button wired to it silently does nothing.
//
// Both routes below need transient user activation, which the browser keeps
// alive for a few seconds after a click. Unity dispatches the button press
// from its frame loop rather than from the DOM handler, but that runs well
// inside the activation window, so a copy issued in response to a click works.

mergeInto(LibraryManager.library, {
  // Returns 1 when the text reached the clipboard, 0 otherwise.
  HiveChameleonCopyText: function (textPtr) {
    var text = UTF8ToString(textPtr);
    var copied = 0;

    // execCommand is deprecated but synchronous, so it is the only route that
    // can report a truthful result back to C# on this call.
    try {
      var area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.top = "-1000px";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.focus();
      area.select();
      area.setSelectionRange(0, area.value.length);
      copied = document.execCommand("copy") ? 1 : 0;
      document.body.removeChild(area);
    } catch (e) {
      copied = 0;
    }

    // Preferred route where available. It resolves asynchronously, so it can
    // only upgrade the result; it never downgrades a successful sync copy.
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          function () {},
          function () {}
        );
        copied = 1;
      }
    } catch (e) {
      // Keep whatever the synchronous route achieved.
    }

    return copied;
  },
});
