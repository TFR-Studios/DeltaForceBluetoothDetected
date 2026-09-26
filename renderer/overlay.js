/* global lottie */
/**
 * bt-anim 渲染层：接收主进程指令，在最顶层透明窗口里播放 Lottie 动画。
 */
(function () {
  'use strict';

  var stage = document.getElementById('stage');
  var container = document.getElementById('anim');
  var captionEl = document.getElementById('caption');
  var veilEl = document.getElementById('veil');

  var baseData = null;
  var meta = null;
  var playback = null;
  var anim = null;
  var currentSession = null;
  var watchdog = null;
  var probeTimer = null;
  var finished = false;

  function log(message, extra) {
    try { window.btAnim.log(message, extra); } catch (err) { /* 忽略 */ }
  }

  function fitPreserveAspect(fit) {
    if (fit === 'contain') return 'xMidYMid meet';
    if (fit === 'stretch') return 'none';
    return 'xMidYMid slice';
  }

  /** 按设备数量改写动画里的数字文本图层 */
  function buildData(count) {
    var data = JSON.parse(JSON.stringify(baseData));
    if (!playback.counter || !count || !meta || !meta.counterLayers || !meta.counterLayers.length) return data;
    var wanted = String(count);
    var layers = data.layers || [];
    for (var i = 0; i < layers.length; i++) {
      var layer = layers[i];
      if (layer.ty !== 5) continue;
      var isCounter = false;
      for (var j = 0; j < meta.counterLayers.length; j++) {
        if (meta.counterLayers[j].ind === layer.ind) { isCounter = true; break; }
      }
      if (!isCounter) continue;
      var docs = (layer.t && layer.t.d && layer.t.d.k) || [];
      for (var k = 0; k < docs.length; k++) {
        if (docs[k] && docs[k].s && typeof docs[k].s.t === 'string') docs[k].s.t = wanted;
      }
    }
    return data;
  }

  function showCaption(payload) {
    if (!playback.caption || !payload) {
      captionEl.classList.add('hidden');
      return;
    }
    captionEl.textContent = '';
    var kindEl = document.createElement('span');
    kindEl.className = 'caption-kind';
    kindEl.textContent = payload.label || '蓝牙事件';
    var nameEl = document.createElement('span');
    nameEl.textContent = payload.name || '';
    captionEl.appendChild(kindEl);
    captionEl.appendChild(nameEl);
    captionEl.classList.remove('hidden');
  }

  function destroyAnimation() {
    if (anim) {
      try { anim.destroy(); } catch (err) { /* 忽略 */ }
      anim = null;
    }
    container.innerHTML = '';
  }

  function clearStage() {
    if (probeTimer) { clearTimeout(probeTimer); probeTimer = null; }
    destroyAnimation();
    stage.classList.remove('active');
    if (veilEl) veilEl.style.opacity = '0';
    captionEl.classList.add('hidden');
  }

  function finish(reason) {
    if (finished) return;
    finished = true;
    var sessionId = currentSession;
    clearStage();
    log('播放结束（' + reason + '）');
    try { window.btAnim.done({ sessionId: sessionId, reason: reason }); } catch (err) { /* 忽略 */ }
  }

  function applyWindowStyle() {
    if (veilEl) veilEl.style.opacity = String(playback.backdrop || 0);
    container.style.filter = playback.boost && playback.boost !== 1 ? ('brightness(' + playback.boost + ')') : 'none';
  }

  function play(message) {
    if (!baseData) {
      log('动画数据尚未就绪，忽略本次播放');
      return;
    }
    finished = false;
    if (watchdog) { clearTimeout(watchdog); watchdog = null; }
    destroyAnimation();

    currentSession = message.sessionId;
    var payload = message.payload || {};
    var data = buildData(payload.count);

    applyWindowStyle();
    stage.classList.add('active');
    showCaption(payload);

    try {
      anim = lottie.loadAnimation({
        container: container,
        renderer: 'svg',
        loop: false,
        autoplay: false,
        animationData: data,
        rendererSettings: {
          preserveAspectRatio: fitPreserveAspect(playback.fit),
          progressiveLoad: true,
          hideOnTransparent: true,
        },
      });
    } catch (err) {
      log('创建动画失败: ' + err.message);
      finish('error');
      return;
    }

    anim.setSpeed(playback.speed || 1);
    anim.addEventListener('complete', function () { finish('complete'); });
    anim.addEventListener('data_failed', function () { log('动画数据加载失败'); });

    var from = playback.from;
    var to = playback.to;
    var start = function () {
      try {
        if (from !== null && to !== null) anim.playSegments([from, to], true);
        else anim.play();
        log('开始播放', { from: from, to: to, total: anim.totalFrames });
      } catch (err) {
        log('播放失败: ' + err.message);
        finish('error');
      }
    };
    if (anim.isLoaded) start();
    else anim.addEventListener('DOMLoaded', start);

    if (probeTimer) clearTimeout(probeTimer);
    probeTimer = setTimeout(function () {
      probeTimer = null;
      if (anim) log('播放中', { frame: Math.round(anim.currentFrame), total: anim.totalFrames });
    }, 1500);

    var wait = Math.max(1500, Number(message.waitMs) || 30000);
    watchdog = setTimeout(function () { finish('watchdog'); }, wait);
  }

  window.btAnim.onInit(function (payload) {
    baseData = payload.animation;
    meta = payload.meta;
    playback = payload.playback || { from: null, to: null, speed: 1, fit: 'cover', backdrop: 0, boost: 1 };
    applyWindowStyle();
    log('渲染层就绪', {
      durationMs: meta && meta.durationMs,
      from: playback.from,
      to: playback.to,
      counterLayers: meta && meta.counterLayers ? meta.counterLayers.length : 0,
    });
  });

  window.btAnim.onPlay(function (message) { play(message); });
  window.btAnim.onStop(function () {
    finished = true;
    if (watchdog) { clearTimeout(watchdog); watchdog = null; }
    clearStage();
  });

  window.addEventListener('error', function (event) {
    log('页面错误: ' + (event && event.message));
  });

  window.btAnim.ready();
})();
