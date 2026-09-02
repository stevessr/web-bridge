import 'dart:async';

import 'package:flutter/material.dart';

import 'models/account_route.dart';
import 'services/server_gateway.dart';

void main() => runApp(const WebBridgeApp());

class WebBridgeApp extends StatelessWidget {
  const WebBridgeApp({super.key});

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
      home: const HomePage(),
    );
  }
}

class HomePage extends StatefulWidget {
  const HomePage({super.key});

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

  ServerGateway? gateway;
  StreamSubscription<Map<String, dynamic>>? subscription;
  String status = 'Disconnected';

  Future<void> connect() async {
    await subscription?.cancel();
    await gateway?.close();

    final next = ServerGateway(
      Uri.parse(serverController.text),
      tokenController.text,
    );
    await next.connect();
    subscription = next.events.listen(handleFrame);
    gateway = next;
    next.listAccounts();

    if (mounted) {
      setState(() => status = 'Server connected');
    }
  }

  void handleFrame(Map<String, dynamic> frame) {
    switch (frame['type']) {
      case 'accounts':
        final snapshots = frame['accounts'] as List<dynamic>;
        for (final raw in snapshots) {
          final account = AccountRoute.fromJson(raw as Map<String, dynamic>);
          accounts[account.key] = account;
          activeAccount.putIfAbsent(account.network, () => account.key);
        }
      case 'account_changed':
        final account = AccountRoute.fromJson(
          frame['account'] as Map<String, dynamic>,
        );
        accounts[account.key] = account;
        activeAccount.putIfAbsent(account.network, () => account.key);
      case 'account_removed':
        final raw = frame['account'] as Map<String, dynamic>;
        final network = ChatNetwork.values.byName(raw['network'] as String);
        final key = '${network.name}:${raw['id']}';
        accounts.remove(key);
        if (activeAccount[network] == key) {
          final replacement = accounts.values
              .where((account) => account.network == network)
              .firstOrNull;
          if (replacement == null) {
            activeAccount.remove(network);
          } else {
            activeAccount[network] = replacement.key;
          }
        }
      case 'error':
        status = '${frame['code']}: ${frame['message']}';
    }
    if (mounted) {
      setState(() {});
    }
  }

  Future<void> addServerAccount() async {
    if (gateway == null) {
      setState(() => status = 'Connect the server first');
      return;
    }

    var network = ChatNetwork.matrix;
    final idController = TextEditingController();
    final nameController = TextEditingController();
    final accepted = await showDialog<bool>(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: const Text('Add server-owned account'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              DropdownButtonFormField<ChatNetwork>(
                initialValue: network,
                items: ChatNetwork.values
                    .map(
                      (item) => DropdownMenuItem(
                        value: item,
                        child: Text(item.name.toUpperCase()),
                      ),
                    )
                    .toList(),
                onChanged: (value) => setDialogState(
                  () => network = value ?? network,
                ),
                decoration: const InputDecoration(labelText: 'Network'),
              ),
              TextField(
                controller: idController,
                decoration: const InputDecoration(labelText: 'Account ID'),
              ),
              TextField(
                controller: nameController,
                decoration: const InputDecoration(
                  labelText: 'Display name (optional)',
                ),
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('Add'),
            ),
          ],
        ),
      ),
    );

    if (accepted == true && idController.text.trim().isNotEmpty) {
      gateway!.registerAccount(
        network: network.name,
        accountId: idController.text.trim(),
        displayName: nameController.text.trim().isEmpty
            ? null
            : nameController.text.trim(),
        route: RouteMode.server.name,
      );
    }
  }

  @override
  void dispose() {
    subscription?.cancel();
    gateway?.close();
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
            onPressed: addServerAccount,
            tooltip: 'Add account',
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
            decoration: const InputDecoration(labelText: 'Client token'),
          ),
          const SizedBox(height: 10),
          FilledButton.icon(
            onPressed: connect,
            icon: const Icon(Icons.cloud_done_outlined),
            label: const Text('Connect server'),
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
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
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
                      message: 'QQ is always routed through the server',
                      child: Icon(Icons.lock_outline, size: 18),
                    ),
                ],
              ),
            ),
            if (items.isEmpty)
              const Padding(
                padding: EdgeInsets.fromLTRB(16, 8, 16, 12),
                child: Text('No accounts'),
              )
            else
              for (final account in items)
                RadioListTile<String>(
                  value: account.key,
                  groupValue: activeAccount[network],
                  onChanged: (value) {
                    if (value != null) {
                      setState(() => activeAccount[network] = value);
                    }
                  },
                  title: Text(account.label),
                  subtitle: Text(
                    '${account.accountId} · ${account.mode.name} · ${account.status.name}',
                  ),
                  secondary: _statusIcon(account.status),
                ),
          ],
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

extension FirstOrNull<T> on Iterable<T> {
  T? get firstOrNull {
    final iterator = this.iterator;
    return iterator.moveNext() ? iterator.current : null;
  }
}
