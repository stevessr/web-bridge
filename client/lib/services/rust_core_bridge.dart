import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../src/rust/api.dart' as rust_api;
import '../src/rust/frb_generated.dart';

typedef CoreFrame = Map<String, dynamic>;

class RustCoreBridge {
  RustCoreBridge({FlutterSecureStorage? secureStorage})
    : _secureStorage = secureStorage ?? const FlutterSecureStorage();

  static const _deviceIdStorageKey = 'web_bridge.device_id';
  static const _requestTimeout = Duration(seconds: 30);

  final FlutterSecureStorage _secureStorage;
  final StreamController<CoreFrame> _events =
      StreamController<CoreFrame>.broadcast();
  final Map<String, Completer<CoreFrame>> _pending =
      <String, Completer<CoreFrame>>{};
  final Map<String, CoreFrame> _completedBeforeWait = <String, CoreFrame>{};

  Timer? _pollTimer;
  bool _initialized = false;

  Stream<CoreFrame> get events => _events.stream;

  Future<void> init() async {
    if (_initialized) {
      return;
    }
    await RustLib.init();
    _initialized = true;
    _pollTimer = Timer.periodic(
      const Duration(milliseconds: 150),
      (_) => _drainEvents(),
    );
  }

  int get protocolVersion => rust_api.protocolVersion();

  bool routeIsAllowed(String network, String route) =>
      rust_api.routeIsAllowed(network: network, route: route);

  Future<void> connect({
    required String endpoint,
    required String token,
  }) async {
    await rust_api.connectServer(
      endpoint: endpoint,
      token: token,
      deviceId: await _deviceId(),
    );
  }

  void disconnect() => rust_api.disconnectServer();

  Future<void> execute(Map<String, dynamic> command) async {
    final raw = await rust_api.executeCommandJson(
      commandJson: jsonEncode(command),
    );
    _emitCommandResult(raw);
  }

  Future<CoreFrame> executeAndWait(
    Map<String, dynamic> command, {
    Duration timeout = _requestTimeout,
  }) async {
    final raw = await rust_api.executeCommandJson(
      commandJson: jsonEncode(command),
    );
    final decoded = jsonDecode(raw);
    if (decoded is List) {
      final frames = decoded
          .whereType<Map>()
          .map((frame) => Map<String, dynamic>.from(frame))
          .toList(growable: false);
      for (final frame in frames) {
        _handleFrame(frame);
      }
      return frames.lastWhere(
        _isTerminalRequestFrame,
        orElse: () => throw StateError(
          'Rust command returned no terminal request frame',
        ),
      );
    }
    if (decoded is! Map) {
      throw const FormatException('Rust command result has invalid JSON shape');
    }
    final metadata = Map<String, dynamic>.from(decoded);
    final requestId = metadata['request_id']?.toString();
    if (requestId == null || requestId.isEmpty || metadata['forwarded'] != true) {
      throw const FormatException('Remote command result has no request_id');
    }

    final alreadyCompleted = _completedBeforeWait.remove(requestId);
    if (alreadyCompleted != null) {
      return alreadyCompleted;
    }
    final completer = Completer<CoreFrame>();
    _pending[requestId] = completer;
    try {
      return await completer.future.timeout(timeout);
    } on TimeoutException {
      _pending.remove(requestId);
      throw TimeoutException('Core request $requestId timed out', timeout);
    }
  }

  Future<CoreFrame> uploadMedia({
    required String network,
    required String accountId,
    required String route,
    required String path,
    String filename = '',
    String contentType = '',
  }) async {
    final raw = await rust_api.uploadMedia(
      network: network,
      accountId: accountId,
      route: route,
      path: path,
      filename: filename,
      contentType: contentType,
    );
    final decoded = jsonDecode(raw);
    if (decoded is! Map) {
      throw const FormatException('Rust media result was not a JSON object');
    }
    return Map<String, dynamic>.from(decoded);
  }

  List<CoreFrame> listAccounts() {
    final decoded = jsonDecode(rust_api.listAccountsJson());
    if (decoded is! List) {
      throw const FormatException('Rust account registry was not a JSON list');
    }
    return decoded
        .whereType<Map>()
        .map((item) => Map<String, dynamic>.from(item))
        .toList(growable: false);
  }

  void dispose() {
    _pollTimer?.cancel();
    _pollTimer = null;
    for (final completer in _pending.values) {
      if (!completer.isCompleted) {
        completer.completeError(StateError('Rust core bridge disposed'));
      }
    }
    _pending.clear();
    _completedBeforeWait.clear();
    _events.close();
    if (_initialized) {
      RustLib.dispose();
      _initialized = false;
    }
  }

  void _drainEvents() {
    if (!_initialized || _events.isClosed) {
      return;
    }
    try {
      final decoded = jsonDecode(rust_api.drainEventsJson());
      if (decoded is! List) {
        throw const FormatException('Rust event queue was not a JSON list');
      }
      for (final raw in decoded.whereType<Map>()) {
        _handleFrame(Map<String, dynamic>.from(raw));
      }
    } catch (error) {
      _handleFrame(<String, dynamic>{
        'type': 'error',
        'code': 'flutter_rust_event_bridge',
        'message': error.toString(),
      });
    }
  }

  void _emitCommandResult(String raw) {
    final decoded = jsonDecode(raw);
    if (decoded is! List) {
      // Remote commands return forwarding metadata. Their response arrives
      // asynchronously through the Rust RemoteBridge event queue.
      return;
    }
    for (final frame in decoded.whereType<Map>()) {
      _handleFrame(Map<String, dynamic>.from(frame));
    }
  }

  void _handleFrame(CoreFrame frame) {
    if (!_events.isClosed) {
      _events.add(frame);
    }
    if (!_isTerminalRequestFrame(frame)) {
      return;
    }
    final requestId = frame['request_id']?.toString();
    if (requestId == null || requestId.isEmpty) {
      return;
    }
    final completer = _pending.remove(requestId);
    if (completer != null) {
      if (!completer.isCompleted) {
        completer.complete(frame);
      }
      return;
    }
    _completedBeforeWait[requestId] = frame;
    if (_completedBeforeWait.length > 128) {
      _completedBeforeWait.remove(_completedBeforeWait.keys.first);
    }
  }

  bool _isTerminalRequestFrame(CoreFrame frame) {
    if (frame['request_id'] == null) {
      return false;
    }
    return switch (frame['type']) {
      'ack' || 'error' || 'conversations' || 'messages' || 'cursor' => true,
      _ => false,
    };
  }

  Future<String> _deviceId() async {
    try {
      final existing = await _secureStorage.read(key: _deviceIdStorageKey);
      if (existing != null && existing.isNotEmpty) {
        return existing;
      }
      final generated = _newDeviceId();
      await _secureStorage.write(
        key: _deviceIdStorageKey,
        value: generated,
      );
      return generated;
    } catch (_) {
      return _newDeviceId();
    }
  }

  String _newDeviceId() {
    final random = Random.secure();
    final bytes = List<int>.generate(18, (_) => random.nextInt(256));
    return 'flutter-${base64Url.encode(bytes).replaceAll('=', '')}';
  }
}
