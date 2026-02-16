import 'dart:async';

import 'package:collection/collection.dart';

import '/backend/schema/util/firestore_util.dart';

import 'index.dart';
import '/flutter_flow/flutter_flow_util.dart';

class ServiceCategoriesRecord extends FirestoreRecord {
  ServiceCategoriesRecord._(
    DocumentReference reference,
    Map<String, dynamic> data,
  ) : super(reference, data) {
    _initializeFields();
  }

  // "name" field.
  String? _name;
  String get name => _name ?? '';
  bool hasName() => _name != null;

  // "color" field.
  Color? _color;
  Color? get color => _color;
  bool hasColor() => _color != null;

  // "calendar" field.
  bool? _calendar;
  bool get calendar => _calendar ?? false;
  bool hasCalendar() => _calendar != null;

  // "workers" field.
  bool? _workers;
  bool get workers => _workers ?? false;
  bool hasWorkers() => _workers != null;

  void _initializeFields() {
    _name = snapshotData['name'] as String?;
    _color = getSchemaColor(snapshotData['color']);
    _calendar = snapshotData['calendar'] as bool?;
    _workers = snapshotData['workers'] as bool?;
  }

  static CollectionReference get collection =>
      FirebaseFirestore.instance.collection('serviceCategories');

  static Stream<ServiceCategoriesRecord> getDocument(DocumentReference ref) =>
      ref.snapshots().map((s) => ServiceCategoriesRecord.fromSnapshot(s));

  static Future<ServiceCategoriesRecord> getDocumentOnce(
          DocumentReference ref) =>
      ref.get().then((s) => ServiceCategoriesRecord.fromSnapshot(s));

  static ServiceCategoriesRecord fromSnapshot(DocumentSnapshot snapshot) =>
      ServiceCategoriesRecord._(
        snapshot.reference,
        mapFromFirestore(snapshot.data() as Map<String, dynamic>),
      );

  static ServiceCategoriesRecord getDocumentFromData(
    Map<String, dynamic> data,
    DocumentReference reference,
  ) =>
      ServiceCategoriesRecord._(reference, mapFromFirestore(data));

  @override
  String toString() =>
      'ServiceCategoriesRecord(reference: ${reference.path}, data: $snapshotData)';

  @override
  int get hashCode => reference.path.hashCode;

  @override
  bool operator ==(other) =>
      other is ServiceCategoriesRecord &&
      reference.path.hashCode == other.reference.path.hashCode;
}

Map<String, dynamic> createServiceCategoriesRecordData({
  String? name,
  Color? color,
  bool? calendar,
  bool? workers,
}) {
  final firestoreData = mapToFirestore(
    <String, dynamic>{
      'name': name,
      'color': color,
      'calendar': calendar,
      'workers': workers,
    }.withoutNulls,
  );

  return firestoreData;
}

class ServiceCategoriesRecordDocumentEquality
    implements Equality<ServiceCategoriesRecord> {
  const ServiceCategoriesRecordDocumentEquality();

  @override
  bool equals(ServiceCategoriesRecord? e1, ServiceCategoriesRecord? e2) {
    return e1?.name == e2?.name &&
        e1?.color == e2?.color &&
        e1?.calendar == e2?.calendar &&
        e1?.workers == e2?.workers;
  }

  @override
  int hash(ServiceCategoriesRecord? e) =>
      const ListEquality().hash([e?.name, e?.color, e?.calendar, e?.workers]);

  @override
  bool isValidKey(Object? o) => o is ServiceCategoriesRecord;
}
