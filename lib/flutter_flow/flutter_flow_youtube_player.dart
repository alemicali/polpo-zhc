/*
Copyright 2021 Sarbagya Dhaubanjar. All rights reserved.

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above
      copyright notice, this list of conditions and the following
      disclaimer in the documentation and/or other materials provided
      with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

import 'package:flutter/foundation.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:youtube_player_iframe/youtube_player_iframe.dart';

import '/flutter_flow/flutter_flow_util.dart' show routeObserver;

const kYoutubeAspectRatio = 16 / 9;
final _youtubeFullScreenControllerMap = <String, YoutubePlayerController>{};

class FlutterFlowYoutubePlayer extends StatefulWidget {
  const FlutterFlowYoutubePlayer({
    super.key,
    required this.url,
    this.width,
    this.height,
    this.autoPlay = false,
    this.mute = false,
    this.looping = false,
    this.showControls = true,
    this.showFullScreen = false,
    this.pauseOnNavigate = true,
    this.strictRelatedVideos = false,
  });

  final String url;
  final double? width;
  final double? height;
  final bool autoPlay;
  final bool mute;
  final bool looping;
  final bool showControls;
  final bool showFullScreen;
  final bool pauseOnNavigate;
  final bool strictRelatedVideos;

  @override
  State<FlutterFlowYoutubePlayer> createState() =>
      _FlutterFlowYoutubePlayerState();
}

class _FlutterFlowYoutubePlayerState extends State<FlutterFlowYoutubePlayer>
    with RouteAware {
  YoutubePlayerController? _controller;
  String? _videoId;
  _YoutubeFullScreenWrapperState? _youtubeWrapper;
  bool _subscribedRoute = false;

  bool get handleFullScreen =>
      !kIsWeb && widget.showFullScreen && _youtubeWrapper != null;

  @override
  void initState() {
    super.initState();
    initializePlayer();
  }

  @override
  void dispose() {
    if (!handleFullScreen || _youtubeWrapper?._controller == null) {
      if (_subscribedRoute) {
        routeObserver.unsubscribe(this);
      }
      _controller?.close();
      _youtubeFullScreenControllerMap[_videoId]?.close();
      _youtubeFullScreenControllerMap.remove(_videoId);
    }
    super.dispose();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (widget.pauseOnNavigate && ModalRoute.of(context) is PageRoute) {
      _subscribedRoute = true;
      routeObserver.subscribe(this, ModalRoute.of(context)!);
    }
  }

  @override
  void didPushNext() {
    if (widget.pauseOnNavigate) {
      _controller?.pauseVideo();
    }
  }

  double get width => widget.width == null || widget.width! >= double.infinity
      ? MediaQuery.sizeOf(context).width
      : widget.width!;

  double get height =>
      widget.height == null || widget.height! >= double.infinity
          ? width / kYoutubeAspectRatio
          : widget.height!;

  void initializePlayer() {
    if (!mounted) {
      return;
    }
    final videoId = _convertUrlToId(widget.url);
    if (videoId == null) {
      return;
    }
    _videoId = videoId;
    _youtubeWrapper = YoutubeFullScreenWrapper.of(context);

    if (handleFullScreen &&
        _youtubeFullScreenControllerMap.containsKey(_videoId)) {
      _controller = _youtubeFullScreenControllerMap[_videoId]!;
      _youtubeFullScreenControllerMap.clear();
    } else {
      _controller = YoutubePlayerController.fromVideoId(
        videoId: videoId,
        autoPlay: widget.autoPlay,
        params: YoutubePlayerParams(
          mute: widget.mute,
          loop: widget.looping,
          showControls: widget.showControls,
          showFullscreenButton: widget.showFullScreen,
          strictRelatedVideos: widget.strictRelatedVideos,
        ),
      );
    }
    if (handleFullScreen) {
      _controller!.setFullScreenListener((fullScreen) {
        if (fullScreen) {
          _youtubeFullScreenControllerMap[_videoId!] = _controller!;
          _youtubeWrapper!.updateYoutubePlayer(_controller, _videoId);
        } else {
          _youtubeWrapper!.updateYoutubePlayer();
        }
      });
    }
  }

  @override
  Widget build(BuildContext context) => FittedBox(
        fit: BoxFit.cover,
        child: Container(
          height: height,
          width: width,
          child: _controller != null
              ? handleFullScreen
                  ? YoutubePlayerScaffold(
                      controller: _controller!,
                      builder: (_, player) => player,
                      autoFullScreen: false,
                      gestureRecognizers: const <Factory<
                          TapGestureRecognizer>>{},
                      enableFullScreenOnVerticalDrag: false,
                    )
                  : YoutubePlayer(
                      controller: _controller!,
                      gestureRecognizers: const <Factory<
                          TapGestureRecognizer>>{},
                      enableFullScreenOnVerticalDrag: false,
                    )
              : Container(color: Colors.transparent),
        ),
      );
}

/// Wraps the page in order to properly show the YouTube video when fullscreen.
class YoutubeFullScreenWrapper extends StatefulWidget {
  YoutubeFullScreenWrapper({Key? key, required this.child}) : super(key: key);

  final Widget child;

  static _YoutubeFullScreenWrapperState? of(BuildContext context) =>
      context.findAncestorStateOfType<_YoutubeFullScreenWrapperState>();

  @override
  State<YoutubeFullScreenWrapper> createState() =>
      _YoutubeFullScreenWrapperState();
}

class _YoutubeFullScreenWrapperState extends State<YoutubeFullScreenWrapper> {
  YoutubePlayerController? _controller;
  String? _videoId;

  void updateYoutubePlayer([
    YoutubePlayerController? controller,
    String? videoId,
  ]) =>
      setState(() {
        _controller = controller;
        _videoId = videoId;
      });

  @override
  void dispose() {
    _controller?.close();
    _youtubeFullScreenControllerMap.remove(_videoId);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => _controller != null
      ? YoutubePlayerScaffold(
          controller: _controller!,
          builder: (_, player) => player,
          enableFullScreenOnVerticalDrag: false,
        )
      : widget.child;
}

String? _convertUrlToId(String url, {bool trimWhitespaces = true}) {
  assert(url.isNotEmpty, 'Url cannot be empty');
  if (!url.contains("http") && (url.length == 11)) return url;
  if (trimWhitespaces) url = url.trim();
  for (final regex in [
    RegExp(
      r"^https:\/\/(?:www\.|m\.)?youtube\.com\/watch\?v=([_\-a-zA-Z0-9]{11}).*$",
    ),
    RegExp(
      r"^https:\/\/(?:www\.|m\.)?youtube(?:-nocookie)?\.com\/embed\/([_\-a-zA-Z0-9]{11}).*$",
    ),
    RegExp(r"^https:\/\/youtu\.be\/([_\-a-zA-Z0-9]{11}).*$")
  ]) {
    final match = regex.firstMatch(url);
    if (match != null && match.groupCount >= 1) return match.group(1);
  }
  return null;
}
