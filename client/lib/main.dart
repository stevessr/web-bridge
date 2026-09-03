import 'dart:async';

import 'package:flutter/material.dart';

import 'history_page.dart';
import 'models/account_route.dart';
import 'services/rust_core_bridge.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final bridge = RustCoreBridge();
  await bridge.init();
  runApp(WebBridgeApp(bridge: bridge));
}

class WebBridgeApp extends StatelessWidget {
  const WebBridgeApp({required this.bridge, super.key});

  final RustCoreBridge bridge;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'web-bridge',
      theme: ThemeData(colorSchemeSeed: Colors.blue, useMaterial3: true),
      darkTheme: ThemeData(
        colorSchemeSeed: Colors.blue,
        brightness: Brightness.dark,
        useMaterial3: true,
      ),
      home: HomePage(bridge: bridge),
    );
  }
}

class HomePage extends StatefulWidget {
  const HomePage({required this.bridge, super.key});

  final RustCoreBridge bridge;

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  final serverController = TextEditingController(
    text: 'ws://127.0.0.1:8787/v1/ws',
  );
  final tokenController = TextEditingController(text: 'dev-client-token');
  final accounts = <String, AccountRoute>{};
  final activeAccount = <ChatNetwork, String>{};
  final telegramChallenges = <String, _TelegramChallenge>{};
  final telegramChallengeInputs = <String, TextEditingController>{};

  StreamSubscription<CoreFrame>? subscription;
  String status = 'Rust core ready';
  bool serverSessionActive = false;

  @override
  void initState() {
    super.initState();
    subscription = widget.bridge.events.listen(handleFrame);
    _reloadAccounts();
  }

  Future<void> connect() async {
    try {
      await widget.bridge.connect(
        endpoint: serverController.text.trim(),
        token: tokenController.text,
      );
      if (!mounted) {
        return;
      }
      setState(() {
        serverSessionActive = true;
        status =
            'Server connected · protocol v${widget.bridge.protocolVersion}';
      });
      _reloadAccounts();
    } catch (error) {
      if (mounted) {
        setState(() {
          serverSessionActive = false;
          status = 'Connect failed: $error';
        });
      }
    }
  }

  void disconnect() {
    try {
      widget.bridge.disconnect();
      setState(() {
        serverSessionActive = false;
        status = 'Server disconnected';
      });
    } catch (error) {
      setState(() => status = 'Disconnect failed: $error');
    }
  }

  void handleFrame(CoreFrame frame) {
    switch (frame['type']) {
      case 'ready':
        status = 'Server ready · protocol v${frame['protocol']}';
        serverSessionActive = true;
      case 'accounts':
      case 'account_changed':
      case 'account_removed':
        _reloadAccounts();
      case 'auth_challenge':
        _handleAuthChallenge(frame);
      case 'message':
        status = 'New message received';
      case 'ack':
        status = 'Request ${frame['request_id']} completed';
      case 'error':
        final code = frame['code'];
        status = '$code: ${frame['message']}';
        if (code == 'remote_disconnected' || code == 'remote_reconnect_failed') {
          serverSessionActive = true;
        }
      case 'pong':
        status = 'Server pong: ${frame['nonce']}';
    }
    if (mounted) {
      setState(() {});
    }
  }

  void _handleAuthChallenge(CoreFrame frame) {
    final account = frame['account'];
    final challenge = frame['challenge'];
    if (account is! Map || challenge is! Map) {
      return;
    }
    if (account['network'] != ChatNetwork.telegram.name) {
      return;
    }

    final accountId = account['id'];
    final type = challenge['type'];
    if (accountId is! String || type is! String) {
      return;
    }

    final key = '${ChatNetwork.telegram.name}:$accountId';
    final input = telegramChallengeInputs.putIfAbsent(
      key,
      TextEditingController.new,
    );
    input.clear();
    telegramChallenges[key] = _TelegramChallenge(
      accountId: accountId,
      type: type,
      hint: challenge['hint'] as String?,
    );
  }

  void _reloadAccounts() {
    try {
      final snapshots = widget.bridge.listAccounts();
      final next = <String, AccountRoute>{};
      for (final raw in snapshots) {
        final account = AccountRoute.fromJson(raw);
        next[account.key] = account;
      }

      if (!mounted) {
        return;
      }
      setState(() {
        accounts
          ..clear()
          ..addAll(next);

        for (final network in ChatNetwork.values) {
          final current = activeAccount[network];
          if (current != null && accounts.containsKey(current)) {
            continue;
          }
          final replacement = accounts.values
              .where((account) => account.network == network)
              .firstOrNull;
          if (replacement == null) {
            activeAccount.remove(network);
          } else {
            activeAccount[network] = replacement.key;
          }
        }

        for (final account in accounts.values) {
          if (account.network == ChatNetwork.telegram &&
              account.status == AccountStatus.online) {
            _clearTelegramChallenge(account.key);
          }
        }
      });
    } catch (error) {
      if (mounted) {
        setState(() => status = 'Account refresh failed: $error');
      }
    }
  }

  Future<void> showAddAccountDialog() async {
    final network = await showDialog<ChatNetwork>(
      context: context,
      builder: (context) => SimpleDialog(
        title: const Text('Add account'),
        children: [
          SimpleDialogOption(
            onPressed: () => Navigator.pop(context, ChatNetwork.matrix),
            child: const ListTile(
              leading: Icon(Icons.grid_view_outlined),
              title: Text('Matrix'),
              subtitle: Text('Login with homeserver credentials'),
            ),
          ),
          SimpleDialogOption(
            onPressed: () => Navigator.pop(context, ChatNetwork.telegram),
            child: const ListTile(
              leading: Icon(Icons.send_outlined),
              title: Text('Telegram'),
              subtitle: Text('Login with phone, code and optional 2FA'),
            ),
          ),
          const Padding(
            padding: EdgeInsets.fromLTRB(24, 12, 24, 4),
            child: Text(
              'QQ accounts are discovered automatically from NapCatQQ and cannot be added here.',
            ),
          ),
        ],
      ),
    );

    switch (network) {
      case ChatNetwork.matrix:
        await showMatrixLoginDialog();
      case ChatNetwork.telegram:
        await showTelegramLoginDialog();
      case ChatNetwork.qq:
      case null:
        return;
    }
  }

  Future<void> showMatrixLoginDialog() async {
    final accountIdController = TextEditingController();
    final homeserverController = TextEditingController();
    final usernameController = TextEditingController();
    final passwordController = TextEditingController();
    var route = RouteMode.client;

    final accepted = await showDialog<bool>(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: const Text('Matrix login'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextField(
                  controller: accountIdController,
                  decoration: const InputDecoration(labelText: 'Account ID'),
                ),
                const SizedBox(height: 8),
                DropdownButtonFormField<RouteMode>(
                  initialValue: route,
                  items: _allowedRoutes(ChatNetwork.matrix)
                      .map(
                        (item) => DropdownMenuItem(
                          value: item,
                          child: Text(item.name),
                        ),
                      )
                      .toList(),
                  onChanged: (value) =>
                      setDialogState(() => route = value ?? route),
                  decoration: const InputDecoration(labelText: 'Route'),
                ),
                const SizedBox(height: 8),
                TextField(
                  controller: homeserverController,
                  decoration: const InputDecoration(labelText: 'Homeserver'),
                ),
                const SizedBox(height: 8),
                TextField(
                  controller: usernameController,
                  decoration: const InputDecoration(labelText: 'Username'),
                ),
                const SizedBox(height: 8),
                TextField(
                  controller: passwordController,
                  obscureText: true,
                  enableSuggestions: false,
                  autocorrect: false,
                  decoration: const InputDecoration(labelText: 'Password'),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('Login'),
            ),
          ],
        ),
      ),
    );

    if (accepted == true) {
      final accountId = accountIdController.text.trim();
      if (accountId.isEmpty ||
          homeserverController.text.trim().isEmpty ||
          usernameController.text.trim().isEmpty ||
          passwordController.text.isEmpty) {
        setState(() => status = 'Matrix login fields cannot be empty');
      } else {
        await _execute(<String, dynamic>{
          'type': 'matrix_login_password',
          'account_id': accountId,
          'route': route.name,
          'homeserver': homeserverController.text.trim(),
          'username': usernameController.text.trim(),
          'password': passwordController.text,
        });
      }
    }

    accountIdController.dispose();
    homeserverController.dispose();
    usernameController.dispose();
    passwordController.dispose();
  }

  Future<void> showTelegramLoginDialog() async {
    final accountIdController = TextEditingController();
    final apiIdController = TextEditingController();
    final apiHashController = TextEditingController();
    final phoneController = TextEditingController();
    var route = RouteMode.client;

    final accepted = await showDialog<bool>(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: const Text('Telegram login'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextField(
                  controller: accountIdController,
                  decoration: const InputDecoration(labelText: 'Account ID'),
                ),
                const SizedBox(height: 8),
                DropdownButtonFormField<RouteMode>(
                  initialValue: route,
                  items: _allowedRoutes(ChatNetwork.telegram)
                      .map(
                        (item) => DropdownMenuItem(
                          value: item,
                          child: Text(item.name),
                        ),
                      )
                      .toList(),
                  onChanged: (value) =>
                      setDialogState(() => route = value ?? route),
                  decoration: const InputDecoration(labelText: 'Route'),
                ),
                const SizedBox(height: 8),
                TextField(
                  controller: apiIdController,
                  keyboardType: TextInputType.number,
                  decoration: const InputDecoration(labelText: 'API ID'),
                ),
                const SizedBox(height: 8),
                TextField(
                  controller: apiHashController,
                  obscureText: true,
                  enableSuggestions: false,
                  autocorrect: false,
                  decoration: const InputDecoration(labelText: 'API Hash'),
                ),
                const SizedBox(height: 8),
                TextField(
                  controller: phoneController,
                  keyboardType: TextInputType.phone,
                  decoration: const InputDecoration(labelText: 'Phone'),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('Continue'),
            ),
          ],
        ),
      ),
    );

    if (accepted == true) {
      final apiId = int.tryParse(apiIdController.text.trim());
      final accountId = accountIdController.text.trim();
      if (accountId.isEmpty ||
          apiId == null ||
          apiHashController.text.trim().isEmpty ||
          phoneController.text.trim().isEmpty) {
        setState(() => status = 'Telegram login fields are invalid');
      } else {
        await _execute(<String, dynamic>{
          'type': 'telegram_begin_login',
          'account_id': accountId,
          'route': route.name,
          'api_id': apiId,
          'api_hash': apiHashController.text.trim(),
          'phone': phoneController.text.trim(),
        });
      }
    }

    accountIdController.dispose();
    apiIdController.dispose();
    apiHashController.dispose();
    phoneController.dispose();
  }

  Future<void> _submitTelegramChallenge(
    String key,
    _TelegramChallenge challenge,
  ) async {
    final input = telegramChallengeInputs[key]?.text ?? '';
    if (input.isEmpty) {
      setState(() => status = 'Telegram challenge input cannot be empty');
      return;
    }

    final command = switch (challenge.type) {
      'telegram_code' => <String, dynamic>{
        'type': 'telegram_submit_code',
        'account_id': challenge.accountId,
        'code': input.trim(),
      },
      'telegram_password' => <String, dynamic>{
        'type': 'telegram_submit_password',
        'account_id': challenge.accountId,
        'password': input,
      },
      _ => null,
    };

    if (command == null) {
      setState(() => status = 'Unsupported auth challenge: ${challenge.type}');
      return;
    }

    await _execute(command);
  }

  Future<void> _execute(Map<String, dynamic> command) async {
    try {
      await widget.bridge.execute(command);
    } catch (error) {
      if (mounted) {
        setState(() => status = 'Command failed: $error');
      }
    }
  }

  List<RouteMode> _allowedRoutes(ChatNetwork network) => RouteMode.values
      .where(
        (route) => widget.bridge.routeIsAllowed(network.name, route.name),
      )
      .toList(growable: false);

  void _clearTelegramChallenge(String key) {
    telegramChallenges.remove(key);
    telegramChallengeInputs.remove(key)?.dispose();
  }

  @override
  void dispose() {
    subscription?.cancel();
    for (final controller in telegramChallengeInputs.values) {
      controller.dispose();
    }
    serverController.dispose();
    tokenController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('web-bridge v2'),
        actions: [
          IconButton(
            onPressed: showAddAccountDialog,
            tooltip: 'Add Matrix or Telegram account',
            icon: const Icon(Icons.person_add_alt_1),
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          Text(
            'One Rust core · multiple accounts',
            style: Theme.of(context).textTheme.headlineSmall,
          ),
          const SizedBox(height: 6),
          Text(status),
          const SizedBox(height: 20),
          TextField(
            controller: serverController,
            decoration: const InputDecoration(labelText: 'Server WebSocket URL'),
          ),
          const SizedBox(height: 10),
          TextField(
            controller: tokenController,
            obscureText: true,
            enableSuggestions: false,
            autocorrect: false,
            decoration: const InputDecoration(labelText: 'Client token'),
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(
                child: FilledButton.icon(
                  onPressed: serverSessionActive ? null : connect,
                  icon: const Icon(Icons.cloud_done_outlined),
                  label: const Text('Connect server'),
                ),
              ),
              const SizedBox(width: 10),
              OutlinedButton.icon(
                onPressed: serverSessionActive ? disconnect : null,
                icon: const Icon(Icons.cloud_off_outlined),
                label: const Text('Disconnect'),
              ),
            ],
          ),
          const SizedBox(height: 24),
          for (final network in ChatNetwork.values) _networkSection(network),
        ],
      ),
    );
  }

  Widget _networkSection(ChatNetwork network) {
    final items = accounts.values
        .where((account) => account.network == network)
        .toList();

    return Card(
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 8, 4),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      network.name.toUpperCase(),
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                  ),
                  if (network == ChatNetwork.qq)
                    const Tooltip(
                      message:
                          'QQ is discovered from NapCatQQ and always routed through the server',
                      child: Icon(Icons.lock_outline, size: 18),
                    )
                  else
                    IconButton(
                      onPressed: network == ChatNetwork.matrix
                          ? showMatrixLoginDialog
                          : showTelegramLoginDialog,
                      tooltip: 'Add ${network.name} account',
                      icon: const Icon(Icons.add),
                    ),
                ],
              ),
            ),
            if (items.isEmpty)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
                child: Text(
                  network == ChatNetwork.qq
                      ? 'No NapCatQQ accounts discovered'
                      : 'No accounts',
                ),
              )
            else
              for (final account in items) _accountTile(account),
            if (network == ChatNetwork.telegram)
              for (final entry in telegramChallenges.entries)
                _telegramChallengeCard(entry.key, entry.value),
          ],
        ),
      ),
    );
  }

  Widget _accountTile(AccountRoute account) {
    final selected = activeAccount[account.network] == account.key;
    final error = account.lastError;

    return ListTile(
      selected: selected,
      onTap: () => setState(
        () => activeAccount[account.network] = account.key,
      ),
      leading: Icon(
        selected ? Icons.radio_button_checked : Icons.radio_button_unchecked,
      ),
      title: Text(account.label),
      subtitle: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            '${account.accountId} · ${account.mode.name} · ${account.status.name}',
          ),
          if (error != null && error.isNotEmpty)
            Text(
              error,
              style: TextStyle(color: Theme.of(context).colorScheme.error),
            ),
        ],
      ),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          IconButton(
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => HistoryPage(
                  bridge: widget.bridge,
                  account: account,
                ),
              ),
            ),
            tooltip: 'Stored history',
            icon: const Icon(Icons.history),
          ),
          _statusIcon(account.status),
        ],
      ),
    );
  }

  Widget _telegramChallengeCard(String key, _TelegramChallenge challenge) {
    final isPassword = challenge.type == 'telegram_password';
    final controller = telegramChallengeInputs[key]!;

    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
      child: Card.outlined(
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                isPassword
                    ? 'Telegram 2FA · ${challenge.accountId}'
                    : 'Telegram code · ${challenge.accountId}',
                style: Theme.of(context).textTheme.titleSmall,
              ),
              if (isPassword && challenge.hint?.isNotEmpty == true) ...[
                const SizedBox(height: 4),
                Text('Hint: ${challenge.hint}'),
              ],
              const SizedBox(height: 8),
              TextField(
                controller: controller,
                obscureText: isPassword,
                enableSuggestions: !isPassword,
                autocorrect: false,
                keyboardType: isPassword
                    ? TextInputType.visiblePassword
                    : TextInputType.number,
                decoration: InputDecoration(
                  labelText: isPassword ? 'Password' : 'Verification code',
                ),
                onSubmitted: (_) =>
                    _submitTelegramChallenge(key, challenge),
              ),
              const SizedBox(height: 8),
              Align(
                alignment: Alignment.centerRight,
                child: FilledButton(
                  onPressed: () => _submitTelegramChallenge(key, challenge),
                  child: const Text('Submit'),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _statusIcon(AccountStatus status) {
    return Icon(
      switch (status) {
        AccountStatus.online => Icons.check_circle_outline,
        AccountStatus.connecting => Icons.sync,
        AccountStatus.error => Icons.error_outline,
        AccountStatus.offline => Icons.circle_outlined,
      },
    );
  }
}

class _TelegramChallenge {
  const _TelegramChallenge({
    required this.accountId,
    required this.type,
    this.hint,
  });

  final String accountId;
  final String type;
  final String? hint;
}

extension FirstOrNull<T> on Iterable<T> {
  T? get firstOrNull {
    final iterator = this.iterator;
    return iterator.moveNext() ? iterator.current : null;
  }
}
